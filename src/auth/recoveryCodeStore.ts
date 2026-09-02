// One-time recovery codes: the ten single-use backup credentials someone
// prints and puts in a drawer, for the day they lose whatever shows them a
// TOTP code. This module owns their whole lifecycle — generating a fresh
// set, counting how many are left, and spending one — so that a controller
// built on top of it never needs to know about bcrypt, prefixes, or
// transactions; it only ever calls these three functions.
//
// **Hallazgos B6 and B7, both measured, are why this file looks the way it
// does.** Ten `bcryptjs.compare` calls at cost 12 take 2646 ms, and during
// that window only ~31 of ~264 event-loop ticks of 10 ms got to run — the
// process sits idle-loop-starved at 88%. Five attempts is 12.4 s of CPU, and
// against the existing bucket of ten logins per fifteen minutes that is 124
// seconds of a stopped server per IP per quarter hour — two or three IPs
// make the whole ERP unusable, and **no code has to be guessed right for
// that to happen** (hallazgo B7). The natural implementation of "check a
// recovery code" — SELECT the ten outstanding rows, loop `bcryptjs.compare`
// against each — *is* the attack. `codigo_recuperacion.prefijo` (migration
// `20260902000001-recovery-code-prefix.ts`) exists so verifying a code costs
// one compare, not ten: at most one row shares an account's (id_usuario,
// prefijo) pair in practice, so there is exactly one candidate before bcrypt
// ever runs. That same narrowing closes a second, free-riding leak: a
// loop-and-return-on-first-match reveals through response time roughly how
// many codes an account has left, and a lookup that narrows to one candidate
// before any compare runs erases that signal by construction.
//
// **Hallazgo B6 is the other half.** The natural SELECT-then-UPDATE leaves a
// 2.6 second window in which ten concurrent guesses of the *same* code all
// read "unused" and all go on to spend it. `gastarCodigo` below never does
// that: the write that marks a code used is the same statement that checks
// it is still unused —
// `UPDATE codigo_recuperacion SET used_at = now() WHERE id = ? AND used_at
// IS NULL` — and `rowCount = 0` means "somebody else already spent this
// one", not an error to report differently.
//
// **Hallazgo C14** is why generating a fresh set requires the caller to
// already hold step-up with the password. This module does not, and cannot,
// enforce that itself — it has no request to inspect — so whichever
// controller calls `regenerarCodigos` is the one place that has to sit
// behind `requireStepUp({ exigeContrasena: true })`. A printed sheet of ten
// codes must never be able to regenerate itself into a fresh ten.
//
// No code, no prefix and no hash ever reaches a log line, a thrown error, or
// an HTTP response more than once. `regenerarCodigos` is the only moment the
// plaintext exists outside bcrypt's input; nothing in this module writes it
// down anywhere after that call returns, and nothing reads it back out.

import { randomInt } from "node:crypto";
import bcryptjs from "bcryptjs";
import type { Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CodigoRecuperacionModel } from "../models/codigoRecuperacion.model.js";
import { BCRYPT_COST } from "../config/security.js";

/**
 * How many codes exist at once. Generating and regenerating both produce
 * exactly this many — there is no state with any other count outstanding.
 */
const CANTIDAD_CODIGOS = 10;

/**
 * The alphabet a code is drawn from: readable aloud over a phone call
 * without the pairs that get misheard or mistyped — no `0`/`O`, no
 * `1`/`I`/`L`. 31 symbols, so every character of a code carries
 * log2(31) ≈ 4.9542 bits.
 */
const ALFABETO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * Characters per code. The design spec (§3) requires 128 bits of entropy;
 * ceil(128 / log2(31)) = 26, and 26 × log2(31) ≈ 128.8 bits — over the
 * requirement with room to spare, and comfortably under bcrypt's 72-byte
 * input limit, so nothing here is the length a much longer code would be
 * silently truncated at.
 */
const LONGITUD_CODIGO = 26;

/**
 * Characters kept in clear as `codigo_recuperacion.prefijo`. Fixed by the
 * migration's `CHAR(8)` — changing this number here without changing the
 * column breaks every future insert.
 */
const LONGITUD_PREFIJO = 8;

/**
 * Matches a code in its canonical form (see `normalizar` below): exactly
 * `LONGITUD_CODIGO` characters, every one of them from `ALFABETO`. The cheap
 * rejection hallazgo B7's "cut by shape" step asks for, before anything
 * touches the database or bcrypt.
 */
const FORMA_CODIGO = new RegExp(`^[${ALFABETO}]{${LONGITUD_CODIGO}}$`);

/**
 * One fresh code, drawn with `randomInt` rather than `randomBytes` (the
 * primitive `opaqueToken.ts` uses for a different job): `randomInt(n)`
 * rejection-samples internally, so mapping into a 31-symbol alphabet carries
 * no modulo bias the way `randomBytes(...)[i] % 31` would.
 */
function generarUnCodigo(): string {
  let codigo = "";
  for (let i = 0; i < LONGITUD_CODIGO; i++) {
    codigo += ALFABETO[randomInt(ALFABETO.length)];
  }
  return codigo;
}

/**
 * Canonicalise whatever a person typing a printed code hands back: strip
 * the whitespace and dashes a phone call or a line-wrapped printout adds,
 * and upper-case it. Generation only ever produces the canonical form
 * already, so this is the one place that has to stay in sync with it — how
 * a code is *displayed* is a client concern this module does not have an
 * opinion on.
 */
function normalizar(bruto: string): string {
  return bruto.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Whether a raw value could possibly be a code this module ever issued.
 *
 * The length bound comes before anything else: `FORMA_CODIGO.test` and
 * `normalizar`'s `.replace` both cost time proportional to the input, and
 * neither is worth spending on however many kilobytes an attacker sends in
 * a request body. `2 × LONGITUD_CODIGO` leaves room for a code split with a
 * handful of separators without accepting anything shaped like an attempt
 * to make this function do real work on garbage.
 */
function tieneFormaDeCodigo(bruto: unknown): bruto is string {
  if (typeof bruto !== "string" || bruto.length === 0 || bruto.length > LONGITUD_CODIGO * 2) {
    return false;
  }
  return FORMA_CODIGO.test(normalizar(bruto));
}

/**
 * Issue a fresh set of ten codes, discarding whatever the account already
 * had outstanding. The same function serves a first issue and every later
 * "I want new ones" — Decision 7 of `docs/plans/2026-09-01-factores-mfa.md`
 * does not distinguish them, and a first issue simply finds nothing
 * outstanding to invalidate.
 *
 * Invalidating the old ten and writing the new ten happen in one
 * transaction, on purpose: a half-succeeded regeneration is the one outcome
 * worse than either whole failure mode, because it leaves someone holding a
 * printed sheet that either does not work (the new codes never landed) or
 * is one of twenty simultaneously live codes (the old ten never died).
 *
 * Returns the ten codes in clear, in generation order. This is the only
 * moment they exist as plaintext anywhere this module can see — nothing
 * here logs them, and nothing here ever reads them back out afterwards.
 *
 * **Not this function's job:** requiring step-up with the password
 * (hallazgo C14) and writing the security-notice bitácora entry that a
 * regeneration just invalidated ten live credentials. Both need a request —
 * an IP, a session, who to notify — that this module never has; they belong
 * to whichever controller calls this.
 *
 * **`opciones.transaction`, added for `confirmTotp` (2026-09-02).** The
 * standalone regenerate-codes endpoint still calls this with nothing and
 * gets its own, self-contained transaction, exactly as before. `confirmTotp`
 * calls it *with* the transaction it is already holding open for
 * `confirmarFactor`/`promoverSesion`/`apagarLaMecha`, so that issuing the
 * first ten recovery codes and confirming the factor they back up commit or
 * roll back together — a factor confirmed with no working recovery net is
 * worse than refusing the confirmation outright, and this codebase has no
 * `useCLS` wired up, so a write that does not explicitly carry the caller's
 * transaction runs on a second pooled connection and would not roll back
 * with it (the same reasoning `gastarCodigo`'s own docstring below gives for
 * threading `opciones.transaction` through its `findAll`).
 */
/**
 * Los diez códigos y sus filas ya hasheadas, listos para escribirse.
 *
 * 🔴 **Separado de la escritura a propósito, y el motivo está medido.** Los
 * diez `bcrypt` a coste 12 cuestan **2646 ms** con el bucle de eventos al 88 %
 * de inanición — la medida está en la cabecera de este módulo. Cuando
 * `confirmTotp` llamaba a `regenerarCodigos` con su transacción ya abierta,
 * esos 2,6 segundos transcurrían **dentro** de ella: reteniendo bloqueos de
 * fila sobre `factor_totp`, `sesiones` y `usuarios`, y una de las quince
 * conexiones del pool, para hacer aritmética que no necesita la base de datos
 * para nada.
 *
 * Preparar fuera y escribir dentro deja la transacción en dos sentencias.
 */
export interface CodigosPreparados {
  codigos: string[];
  filas: {
    id_usuario: number;
    codigo_hash: string;
    prefijo: string;
    used_at: null;
    created_at: Date;
  }[];
  ahora: Date;
}

export async function prepararCodigos(id_usuario: number): Promise<CodigosPreparados> {
  const codigos = Array.from({ length: CANTIDAD_CODIGOS }, generarUnCodigo);
  const ahora = new Date();
  const filas: CodigosPreparados["filas"] = [];
  for (const codigo of codigos) {
    filas.push({
      id_usuario,
      codigo_hash: await bcryptjs.hash(codigo, BCRYPT_COST),
      prefijo: codigo.slice(0, LONGITUD_PREFIJO),
      used_at: null,
      created_at: ahora,
    });
  }
  return { codigos, filas, ahora };
}

/**
 * Las dos escrituras, y nada más. Rápidas: aquí no se hashea nada.
 *
 * Sólo las vigentes: un código ya gastado conserva el `used_at` real que tuvo,
 * como historia. Tocarlo aquí sobrescribiría *cuándo* se usó de verdad con la
 * hora de la regeneración.
 */
export async function escribirCodigos(
  id_usuario: number,
  preparados: CodigosPreparados,
  transaction: Transaction,
): Promise<void> {
  await CodigoRecuperacionModel.update(
    { used_at: preparados.ahora },
    { where: { id_usuario, used_at: null }, transaction },
  );
  await CodigoRecuperacionModel.bulkCreate(preparados.filas, { transaction });
}

export async function regenerarCodigos(
  id_usuario: number,
  opciones: { transaction?: Transaction } = {},
): Promise<string[]> {
  const codigos = Array.from({ length: CANTIDAD_CODIGOS }, generarUnCodigo);
  const ahora = new Date();

  // Sequential, not `Promise.all`: bcryptjs is a pure-JS implementation with
  // no native binding to offload to a worker thread — hallazgo B7's own
  // 88%-stall measurement is proof of that, since a truly threaded compare
  // would never have stolen the event loop in the first place. Ten hashes
  // cost the same total CPU time either way, so `Promise.all` would buy
  // nothing here but the appearance of concurrency. Unlike verifying a code,
  // that cost is acceptable: regenerating sits behind step-up with the
  // password (Decision 7 / hallazgo C14), so it is a rare, authenticated
  // action an anonymous attacker cannot trigger at will, unlike the
  // ten-compare verification loop hallazgo B7 measured.
  const filas: {
    id_usuario: number;
    codigo_hash: string;
    prefijo: string;
    used_at: null;
    created_at: Date;
  }[] = [];
  for (const codigo of codigos) {
    filas.push({
      id_usuario,
      codigo_hash: await bcryptjs.hash(codigo, BCRYPT_COST),
      prefijo: codigo.slice(0, LONGITUD_PREFIJO),
      used_at: null,
      created_at: ahora,
    });
  }

  // Factored out so the same two writes run either inside a transaction this
  // function opens for itself (nobody passed one in) or inside one the
  // caller already holds open (`confirmTotp` — see the docstring above).
  const escribir = async (transaction: Transaction) => {
    // Only the still-outstanding ones: an already-spent code keeps the
    // `used_at` it was genuinely spent at, as history. Touching it here
    // would overwrite *when* it was really used with the regeneration time.
    await CodigoRecuperacionModel.update(
      { used_at: ahora },
      { where: { id_usuario, used_at: null }, transaction },
    );
    await CodigoRecuperacionModel.bulkCreate(filas, { transaction });
  };

  if (opciones.transaction) {
    await escribir(opciones.transaction);
  } else {
    await sequelize.transaction(escribir);
  }

  return codigos;
}

/**
 * How many of the ten are still good to spend.
 *
 * Never the codes themselves, and never even which ones — every caller of
 * this module reaches the plaintext exactly once, from `regenerarCodigos`,
 * and this function has no path back to it.
 *
 * **`opciones.transaction`, added for `confirmTotp` (2026-09-02).** That
 * handler reads this count to decide whether confirming a factor should
 * also mint the first ten recovery codes — "is there already an outstanding
 * sheet this would silently invalidate" — and needs the read to happen
 * inside the same transaction as the rest of its writes so nothing else can
 * spend or regenerate a code in the gap between this count and the decision
 * made from it. `countRecoveryCodes` (the plain `GET`) still calls this with
 * nothing, exactly as before.
 */
export async function contarCodigosRestantes(
  id_usuario: number,
  opciones: { transaction?: Transaction } = {},
): Promise<number> {
  return CodigoRecuperacionModel.count({
    where: { id_usuario, used_at: null },
    transaction: opciones.transaction,
  });
}

/**
 * Spend one code, atomically, or find out somebody else already did.
 *
 * `opciones.transaction` lets a future caller fold this into a wider unit of
 * work — the same shape `tokenStore.ts`'s `consumirToken` already uses, and
 * for the same reason: Task 11 Step 4 of the 4B plan requires that spending
 * a code and sealing the session it satisfies succeed or fail together,
 * because a later write failing on its own would leave someone who spent a
 * real code with nothing to show for it. **This function alone does not
 * finish that composition.** As of this writing `sessionPromotion.ts`'s
 * `promoverSesion` takes no `transaction` parameter of its own, so a caller
 * cannot yet pass the same transaction to both — `promoverSesion` needs the
 * matching parameter before `/auth/mfa/verify` can wrap both calls in one
 * `sequelize.transaction(...)`, the way `password.controller.ts`'s
 * `resetPassword` already composes `consumirToken` with the writes that
 * follow it.
 *
 * Returns `false`, uniformly, for: a value with the wrong shape, no row
 * with a matching prefix, a prefix match whose hash does not match, and a
 * code that matched but lost the race to spend it. Nothing about which of
 * those happened is observable from the outside — hallazgo B12's rule for a
 * cryptographic failure, applied here too: a mistyped code, a corrupted
 * row, and someone else winning the race all answer the same `false`.
 */
export async function gastarCodigo(
  id_usuario: number,
  codigoBruto: string,
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  if (!tieneFormaDeCodigo(codigoBruto)) return false;
  const codigo = normalizar(codigoBruto);
  const prefijo = codigo.slice(0, LONGITUD_PREFIJO);

  // `unscoped()`: `CodigoRecuperacionModel`'s own `defaultScope` excludes
  // `codigo_hash` from every bare read (see that model's comment) — without
  // it, `datos.codigo_hash` below is always `undefined` and this never
  // matches anything, on a perfectly healthy row.
  //
  // `findAll`, not `findOne`: the prefix narrows the field to "essentially
  // one" row, not "provably one" — two of an account's ten codes sharing an
  // 8-character prefix is a ~1-in-8.5-billion accident (31^8 possibilities),
  // not an impossible one. Looping the handful of rows that share a prefix
  // is nothing like the ten-row loop hallazgo B7 measured: that DoS was in
  // scanning *every outstanding code* on *every attempt*; this loop is
  // bounded by how many codes happen to collide on eight characters, which
  // nobody can engineer on demand.
  const candidatas = await CodigoRecuperacionModel.unscoped().findAll({
    where: { id_usuario, prefijo, used_at: null },
    transaction: opciones.transaction,
  });

  for (const fila of candidatas) {
    const datos = fila.get() as { id: number; codigo_hash: string };
    if (!(await bcryptjs.compare(codigo, datos.codigo_hash))) continue;

    // Hallazgo B6, the only acceptable shape: the write that marks this row
    // used is the same statement that checks it is still unused. Never
    // trust the `findAll` above on its own — `used_at IS NULL` is repeated
    // here, against the row this call is about to commit to, so a
    // concurrent winner's `used_at` write makes every loser's `UPDATE`
    // affect zero rows instead of two requests both believing they spent
    // the same code.
    const [count] = await CodigoRecuperacionModel.update(
      { used_at: new Date() },
      {
        where: { id: datos.id, id_usuario, used_at: null },
        transaction: opciones.transaction,
      },
    );
    return count > 0;
  }

  return false;
}
