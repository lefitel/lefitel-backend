// Passkeys: the reads and writes that back `credencial_webauthn`.
//
// Starts with the signature counter, which is the one piece of this table
// that cannot be written by hand anywhere else — see `esContadorDeClon`.

import { type Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";

/**
 * Whether an assertion's signature counter says this credential has been
 * cloned.
 *
 * **The rule, in one sentence:** reject only when the stored counter and the
 * received one are *both* above zero and the received one fails to exceed
 * the stored one. Anything else is accepted.
 *
 * Three things make that wording load-bearing rather than fussy.
 *
 * **1. `guardado` is a string, and the obvious comparisons are holes.** `pg`
 * returns `BIGINT` as a string, always, and `ICredencialWebauthn.counter` is
 * declared to say so. `recibido === guardado` is `false` for every value —
 * `===` never coerces across types — so a rule written as equality rejects
 * nothing, ever. `guardado + 1` concatenates. Only the relational operators
 * coerce the way a reader expects, which is why this function uses one and
 * converts the other side explicitly.
 *
 * **2. Zero is not a small count; it is "this authenticator has no
 * counter".** The WebAuthn specification allows an authenticator to report 0
 * always, and the ones that do are precisely the ones this company will
 * use: iCloud Keychain and Google Password Manager sync a passkey across a
 * person's devices, and a synced credential has no single device to keep a
 * count on. Written as a bare `recibido > guardado`, the second assertion
 * from such a passkey reads `0 > 0`, fails, and the credential stops working
 * one use after it was registered — with an error that looks exactly like a
 * cloned key. That failure is worse than useless: under time pressure the
 * fix somebody reaches for is deleting the check.
 *
 * 🔴 **3. Which means that for a synced passkey this function protects
 * nothing, and the comment has to say so.** Both sides are 0, the rule
 * accepts, and no clone would ever be caught here. What actually stops a
 * captured assertion from being replayed is the single-use challenge in
 * `auth/retoStore.ts` — one statement that marks the challenge spent while
 * checking it is still unspent. If that ever degrades into a read followed
 * by a write, synced passkeys lose their *only* replay defence and this
 * function will not notice.
 *
 * **Failing closed on an unreadable stored value.** A `counter` that does
 * not parse is a corrupt row, not a fresh credential, and `Number("x")` is
 * `NaN` — for which *every* comparison is `false`, so a naive version would
 * answer "not a clone" and let the assertion through. That is the wrong
 * direction to fail in, so an unparseable value is treated as a clone. The
 * column is `NOT NULL DEFAULT 0` and only ever written by this module, so
 * reaching that branch means something else is already broken.
 *
 * ---
 *
 * **4. `@simplewebauthn/server` checks this too, its rule is not the same one,
 * and knowing which wins matters.** Measured in
 * `verifyAuthenticationResponse.js`: it refuses when
 * `(recibido > 0 || guardado > 0) && recibido <= guardado` — **either** side
 * above zero, where this function needs **both**. So the two agree everywhere
 * except one case, `guardado > 0` with `recibido === 0`: an authenticator that
 * counted and then stopped, which is what a credential migrated into a
 * password manager looks like. The library refuses it; this function would
 * allow it.
 *
 * **The library wins, and deliberately so** — it runs after this check and is
 * the stricter of the two, so nothing this function allows can slip past it.
 * That makes this one redundant for the *decision*, and it is kept anyway for
 * something the library cannot give: the library throws one indistinguishable
 * error for every failure it has, and a counter going backwards is the single
 * signal that a credential has been **copied**. Telling that apart is what
 * lets it be filed as `critical` instead of disappearing into the same 400 as
 * a mistyped ceremony. Detection here, refusal there.
 */
export function esContadorDeClon(guardado: string, recibido: number): boolean {
  const anterior = Number(guardado);
  if (!Number.isFinite(anterior)) return true;
  if (anterior <= 0 || recibido <= 0) return false;
  return recibido <= anterior;
}

/**
 * The one credential this assertion could belong to — **scoped to the account
 * that is asking, and that scoping is the whole security property.**
 *
 * 🔴 **The model's own comment says the opposite, and following it opens a
 * hole.** `credencialWebauthn.model.ts` reads: *"Verified against
 * `credential_id` alone — the assertion that comes back at login names only
 * that, with no user to scope the lookup by"*. That is true of the
 * **passwordless** ceremony, where the credential *is* the identity and there
 * is nobody to scope by yet. It is false here, in the second-factor path,
 * where the session already says whose it is.
 *
 * The attack it costs, with no phishing and no malice required. A shared
 * office PC. Beatriz knows Ana's password — a note on a monitor, a shoulder,
 * a password reused elsewhere. She logs in as Ana and the session opens
 * `parcial`, which already reaches `/api/auth/webauthn/login`. She puts **her
 * own finger** on **her own passkey**. The assertion is flawless: right
 * relying party, right origin, valid signature, sane counter. Look the
 * credential up by `credential_id` alone and it resolves to Beatriz's row, the
 * signature checks out against Beatriz's public key, and `promoverSesion` is
 * then called on **Ana's** session — which does not ask whose credential it
 * was. Ana's session goes `completa`. The second factor was decoration.
 *
 * And malice is not needed: with a discoverable credential and no
 * `allowCredentials`, the browser offers **every** passkey on the machine in a
 * picker. Choosing the wrong row promotes the wrong session, silently.
 *
 * The repository already does this four times over — `comprobarDispositivo`,
 * `consumirToken`'s `soloDelUsuario`, `gastarCodigo`, and rule 1 at the top of
 * `mfa.controller.ts`. The owner comes from `req.user`, never from the body.
 */
export async function buscarCredencialDe(
  credentialId: string,
  id_usuario: number,
): Promise<{ id: number; credential_id: string; public_key: Buffer; counter: string } | null> {
  const fila = await CredencialWebauthnModel.findOne({
    where: { credential_id: credentialId, id_usuario },
    // `public_key` is excluded by the model's `defaultScope`, and this is the
    // one caller that genuinely needs it: verifying a signature is what it is
    // for. Asked for by name so the exception is visible here rather than by
    // removing the scope for everybody.
    attributes: ["id", "credential_id", "public_key", "counter"],
  });
  if (!fila) return null;
  return {
    id: fila.dataValues.id,
    credential_id: fila.dataValues.credential_id,
    public_key: fila.dataValues.public_key,
    counter: fila.dataValues.counter,
  };
}

/**
 * Record that this credential was used, and move its counter forward.
 *
 * 🔴 **`GREATEST`, not a plain assignment, and the difference is permanent.**
 * A synced passkey reports 0 on every assertion. Assign that 0 over a stored
 * count of 5 and the column goes backwards — after which every later
 * assertion from a *genuine* device with a real counter looks like it advanced
 * from zero, and clone detection for that credential is off for good, with
 * nothing to indicate it. `GREATEST` makes the write monotonic, so a report of
 * 0 is simply ignored, and it does it inside the statement rather than by
 * reading first and deciding afterwards.
 *
 * `last_used_at` rides along because this is the only moment it can be known,
 * and the list of credentials on screen is what lets somebody recognise a
 * passkey they do not remember.
 */
export async function marcarCredencialUsada(
  id: number,
  contadorRecibido: number,
  opciones: { transaction?: Transaction } = {},
): Promise<void> {
  await CredencialWebauthnModel.update(
    {
      counter: sequelize.fn("GREATEST", sequelize.col("counter"), contadorRecibido) as never,
      last_used_at: new Date(),
    },
    { where: { id }, transaction: opciones.transaction },
  );
}
