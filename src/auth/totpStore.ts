// The `factor_totp` table: writing a fresh secret, reading it back decrypted,
// and tracking the last time step a code was accepted for.
// `docs/plans/2026-09-01-factores-mfa.md` Task 4, hallazgos B3, B5, C10,
// Decision 6.
//
// **Egg and chicken, solved by reserving the id (Step 1).** Decision 6 ties
// the AAD to `factor_totp.id`, never `id_usuario` — `factor_totp_id_usuario_fkey`
// is `ON UPDATE CASCADE`, so an `UPDATE usuarios SET id = ...` (the fix used
// when merging two duplicate accounts, and §3 admits `createUsuario` still does
// not check for a collision) would cascade and silently move the AAD out from
// under a row that never re-encrypted — the secret becomes permanently
// unreadable, with no error anywhere. `factor_totp.id` does not cascade.
//
// But encrypting needs the AAD, and the AAD needs an id that does not exist
// until the row is written. Insert-then-update leaves the row briefly holding
// ciphertext that authenticates against nothing; encrypting under `id_usuario`
// is exactly what Decision 6 forbids. So the id is reserved *before*
// encrypting:
//
//   SELECT nextval(pg_get_serial_sequence('factor_totp', 'id'))
//
// — `pg_get_serial_sequence`, never the literal `factor_totp_id_seq`: today's
// default name is correct today and is not a contract. With that number in
// hand, the AAD and the ciphertext are both known before a single write
// happens, and the row goes in with one `INSERT` carrying its own `id`
// explicitly. If that `INSERT` never happens — the process dies, the
// transaction below rolls back — the only casualty is one skipped number in
// the sequence, which is exactly what sequences are for.
//
// **The write rule this module exists to enforce (Task 1 Step 4, restated
// here because this is where it is actually checked):** `secreto_cifrado`,
// `iv`, `auth_tag` and `key_version` are four separate columns, and Postgres
// has no idea the four of them have to move together. Every write below is a
// single `INSERT` carrying all four; nothing here ever `UPDATE`s a subset of
// them, and nothing here re-encrypts by reusing a stored IV — `cifrar()`
// (`mfaCrypto.ts`) draws a fresh one on every call, with no parameter to
// override that.
//
// **`ultimo_paso` is `BIGINT`, and `pg` hands `BIGINT` back as a *string*,
// never a `number`** — this is hallazgo C10, and it is not a corner case,
// it is how every read of this column behaves. `pasoYaUsado` below is where
// that gets handled; see its own comment for the three rules and why the
// obvious `===` reading of "reject a repeated step" is exactly the version
// that fails.
//
// **The AAD format lives here, and only here.** `auth/mfaKeyCheck.ts`, which
// decrypts a real row at boot to prove the key is the right one, imports
// `aadDeFactorTotp` from this module rather than writing the string again — a
// second copy would agree today and drift in silence, and the drift is
// invisible: decrypting with the wrong AAD looks exactly like a wrong key.

import { Op, QueryTypes } from "sequelize";
import type { Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { cifrar, descifrar } from "./mfaCrypto.js";

/**
 * The AAD for one `factor_totp` row: `factor:<id>`, tied to the row's own
 * primary key per Decision 6, never to `id_usuario`. The only exported
 * source of this string — see the module header for the two files that
 * currently duplicate it instead of importing it, and why that is a live
 * bug waiting for the first key rotation.
 */
export function aadDeFactorTotp(id: number): string {
  return `factor:${id}`;
}

/** What a decrypted row hands back to a reader, before `descifrar` runs. */
interface FilaCifrada {
  id: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
}

function descifrarFila(datos: FilaCifrada): string {
  return descifrar(
    {
      ciphertext: datos.secreto_cifrado,
      iv: datos.iv,
      auth_tag: datos.auth_tag,
      key_version: datos.key_version,
    },
    aadDeFactorTotp(datos.id),
  );
}

/**
 * Write a brand-new, unconfirmed secret for `id_usuario`.
 *
 * Reserves the row's id first (see module header), encrypts under the AAD
 * that id produces, and inserts everything — `id_usuario`, the four crypto
 * columns and `id` itself — in one `INSERT`. Nothing here decides whether
 * this call is allowed: whether a *confirmed* factor already exists (which
 * should answer 409 rather than ever reach this function) is `setup`'s call
 * to make (Task 6), not this store's. What this function does own is *which*
 * row it may replace — the unconfirmed one, and only that one:
 * `factor_totp.id_usuario` is `UNIQUE`, so before inserting it deletes
 * whatever unconfirmed row this account already had (a half-finished `setup`
 * nobody confirmed, safe to discard — see hallazgo C11). It never touches a
 * confirmed row. If the caller got the 409 check wrong and a confirmed row
 * is still there, the `INSERT` below fails loudly against that same
 * `UNIQUE` constraint instead of silently destroying a working factor —
 * exactly the "insert-a-secondary-check-into-the-write-path" defence the
 * dangerous alternatives (`upsert`, `destroy`+`create`) do not offer.
 *
 * Delete and insert share one transaction so a crash between the two never
 * leaves the account with zero rows *and* the caller believing the old one
 * is still there.
 */
export async function guardarSecretoSinConfirmar(
  id_usuario: number,
  secreto: string,
): Promise<{ id: number }> {
  const [{ id: idReservada }] = await sequelize.query<{ id: string }>(
    "SELECT nextval(pg_get_serial_sequence('factor_totp', 'id')) AS id",
    { type: QueryTypes.SELECT },
  );
  // `nextval` returns bigint, handed back as a string for the exact reason
  // `ultimo_paso` is (see the module header) — safe to fold into a plain
  // `number` here because a Postgres `serial`/`int4` sequence never exceeds
  // 2^31, nowhere near `Number.MAX_SAFE_INTEGER`.
  const id = Number(idReservada);
  const aad = aadDeFactorTotp(id);
  const cifrado = cifrar(secreto, aad);

  await sequelize.transaction(async (transaction) => {
    await FactorTotpModel.destroy({
      where: { id_usuario, confirmed_at: null },
      transaction,
    });
    await FactorTotpModel.create(
      {
        id,
        id_usuario,
        secreto_cifrado: cifrado.ciphertext,
        iv: cifrado.iv,
        auth_tag: cifrado.auth_tag,
        key_version: cifrado.key_version,
        ultimo_paso: null,
        confirmed_at: null,
        created_at: new Date(),
      },
      { transaction },
    );
  });

  return { id };
}

/**
 * The decrypted secret of this account's *confirmed* factor, or `null` if it
 * has none. `unscoped()` is required: `FactorTotpModel`'s own `defaultScope`
 * (hallazgo B10) excludes `secreto_cifrado`, `iv` and `auth_tag` from every
 * plain query, so a scoped `findOne` here would always see them as
 * `undefined` and always fail to decrypt on a perfectly healthy row — the
 * same reason `mfaKeyCheck.ts` and `rotateMfaKey.ts` both reach for
 * `unscoped()` too.
 */
export async function leerSecretoConfirmado(id_usuario: number): Promise<string | null> {
  const fila = await FactorTotpModel.unscoped().findOne({
    where: { id_usuario, confirmed_at: { [Op.ne]: null } },
  });
  if (!fila) return null;
  return descifrarFila(fila.get() as FilaCifrada);
}

/**
 * This account's *unconfirmed* factor — the one a `setup` call is waiting to
 * have proved back with a code — decrypted, with its own id (`confirm`,
 * Task 6, needs it to call `sellarPaso` once the code checks out). `null`
 * when there is nothing mid-registration.
 */
export async function leerSecretoSinConfirmar(
  id_usuario: number,
): Promise<{ id: number; secreto: string } | null> {
  const fila = await FactorTotpModel.unscoped().findOne({
    where: { id_usuario, confirmed_at: null },
  });
  if (!fila) return null;
  const datos = fila.get() as FilaCifrada;
  return { id: datos.id, secreto: descifrarFila(datos) };
}

/**
 * Record the time step a code was just accepted for — atomically, or find
 * out somebody else (or a concurrent request for the very same code) got
 * there first.
 *
 * **Hallazgo F4/C-3/A-8: this used to be an unconditional write, and that is
 * exactly what let the same code succeed twice.** `mfa.controller.ts`'s
 * `verificarTotp` reads a row, decides a code is fresh against that snapshot
 * (`pasoYaUsado`), and only then calls this function — two round trips to the
 * database, with a gap between them. Two requests carrying the same code,
 * arriving inside that gap, both read `ultimo_paso` before either writes it,
 * both compute the same accepted step, and an unconditional `UPDATE ...
 * WHERE id = ?` would let both win. Worse, without an ordering guard a *later*
 * writer sealing an *earlier* step (its own valid match inside the ±1
 * tolerance window) would silently move `ultimo_paso` backwards and leave the
 * step the first writer just sealed reusable again.
 *
 * The `WHERE` below repeats the freshness check against the row this call is
 * about to commit to — the same shape `recoveryCodeStore.ts`'s `gastarCodigo`
 * already uses for the identical race on recovery codes (hallazgo B6): never
 * trust a read taken before this statement, trust only what this statement's
 * own `WHERE` still sees true at the instant it runs. `pasoYaUsado`'s
 * snapshot-based check stays useful as a cheap, safe *early reject* — a step
 * it already saw as used cannot un-become used — but it is no longer the
 * thing that decides acceptance; the row count this function returns is.
 *
 * Returns the number of rows the `UPDATE` actually changed: `1` for a genuine
 * seal, `0` for "this step was already sealed, at or after the value being
 * sealed now, by the time this statement ran" — which the caller has to treat
 * exactly like `pasoYaUsado` returning `true`, never as success.
 *
 * `paso` is converted to a plain `number`-shaped string for the write — safe
 * unlike the *read* side (see `pasoYaUsado`): a TOTP step is
 * `Date.now() / 30_000`, nowhere near `Number.MAX_SAFE_INTEGER` for the
 * working lifetime of this software, and the column only ever round-trips as
 * a string once it comes back out of Postgres, not on the way in.
 *
 * The caller decides *which* step to pass, and that choice is the whole of
 * hallazgo C10's third rule: it has to be the step that actually matched
 * against the tolerance window, never `Math.floor(Date.now() / 30_000)`
 * recomputed fresh. With ±1 step of tolerance those are not always the same
 * number, and sealing the server's clock instead of the accepted step
 * leaves the neighbouring step still reusable. This function only ever
 * takes one `paso` — there is no separate "server time" argument to seal by
 * mistake.
 */
export async function sellarPaso(
  id_factor: number,
  paso: bigint,
  opciones: { transaction?: Transaction } = {},
): Promise<number> {
  const pasoTexto = paso.toString();
  const [afectadas] = await FactorTotpModel.update(
    { ultimo_paso: pasoTexto },
    {
      where: {
        id: id_factor,
        [Op.or]: [{ ultimo_paso: null }, { ultimo_paso: { [Op.lt]: pasoTexto } }],
      },
      transaction: opciones.transaction,
    },
  );
  return afectadas;
}

/**
 * Confirm a freshly registered factor: mark it confirmed **and** seal the step
 * that proved it, in **one** statement.
 *
 * Two writes to the same row is what the obvious version does, and it is worth
 * one function to avoid: between them the row is confirmed with no step sealed,
 * so a concurrent verify would accept the very code that just registered it.
 * The window is milliseconds and the fix is free.
 *
 * `paso` is the step that **actually matched**, never the one the server clock
 * produces — with a tolerance of ±1 they are different numbers, and sealing the
 * server's leaves the neighbouring step reusable. And it goes to the database as
 * a string, because that is what a BIGINT column round-trips as: `Number()`
 * happens to be exact for today's step values and defeats the whole reason this
 * is a `bigint` in the first place.
 */
export async function confirmarFactor(
  id_factor: number,
  paso: bigint,
  opciones: { transaction?: Transaction } = {},
): Promise<void> {
  await FactorTotpModel.update(
    { confirmed_at: new Date(), ultimo_paso: paso.toString() },
    { where: { id: id_factor }, transaction: opciones.transaction },
  );
}

/**
 * Whether `paso` has already been accepted, given `ultimo_paso` exactly as
 * it comes back from Postgres.
 *
 * **Three rules, hallazgo C10, all three required:**
 *
 * 1. `paso <= (guardado ?? -1n)`, with `<=` and never `===`. A code is valid
 *    for its whole time window, so anything at or before the last accepted
 *    step is a replay, not only an exact match.
 * 2. `guardado` is `null` on a factor's very first verification —
 *    `ultimo_paso` starts life `NULL` — and `?? -1n` is what makes accepting
 *    that first step a deliberate choice rather than an accident of
 *    coercion: no step is ever `<= -1n`, so a fresh factor always passes.
 * 3. This function only ever compares; it never decides *which* step to
 *    seal afterwards — see `sellarPaso`'s own comment for why that matters.
 *
 * **Why `guardado` stays a `string` all the way into the comparison, and is
 * never converted to a `bigint` first.** `pg` returns `BIGINT` columns as
 * strings — this parameter's type is the actual shape `ultimo_paso` arrives
 * in, not a simplification. `<=` between a `bigint` and a numeric `string`
 * coerces the string and compares correctly (`58012345n <= "58012345"` is
 * `true`); `===` between a `bigint` and a `string` is **`false`
 * unconditionally**, regardless of value — JS's `===` never coerces across
 * types. That gap is hallazgo C10's entire finding: code that reads
 * `paso === ultimo_paso` "to reject a repeated step" silently rejects
 * nothing, ever, and the same six digits stay valid for the whole ±1-step
 * tolerance window, up to about 90 seconds. If a future edit "simplifies"
 * this by parsing `guardado` into a `bigint` before comparing, that edit
 * removes the very thing this function's own test suite mutates to prove
 * still matters — see `totpStore.test.ts`'s comment on that test.
 *
 * The cast on the right-hand side exists only to satisfy TypeScript, which
 * refuses `bigint <= (string | bigint)` outright even though the JS engine
 * handles it correctly (verified against the language specification, not
 * assumed) — it does not change what value reaches the operator at runtime.
 */
export function pasoYaUsado(guardado: string | null, paso: bigint): boolean {
  return paso <= ((guardado ?? -1n) as unknown as bigint);
}
