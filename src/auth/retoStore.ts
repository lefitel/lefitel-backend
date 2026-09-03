import { Op, type Transaction } from "sequelize";
import { RetoWebauthnModel } from "../models/retoWebauthn.model.js";
import { hashOpaqueToken } from "./opaqueToken.js";
import { WEBAUTHN_CHALLENGE_TTL_MS } from "../config/security.js";
import type { IRetoWebauthn } from "../interfaces/index.js";

// The WebAuthn challenge: written down once, spendable once, and gone.
//
// **Why this module exists at all**, given that the challenge could have been
// two columns on `sesiones` the way the design spec first wrote it: a session
// row has one slot and a person can have several ceremonies in flight, there
// is no room on it to record *which* ceremony a challenge was minted for, and
// the passwordless ceremony has no session to put it on. The migration header
// (`20260902000001`) carries the full argument.
//
// **The challenge is minted by `@simplewebauthn/server`, not here.** Its
// `generateRegistrationOptions` / `generateAuthenticationOptions` produce one
// as part of the options they hand the browser, and this module writes down
// the hash of that value. Generating a second source of randomness alongside
// theirs would mean two things called "the challenge" and one of them wrong.

/** What the caller says the challenge is for. Goes inside the redeeming `WHERE`. */
export type PropositoReto = IRetoWebauthn["proposito"];

/**
 * Write down a challenge the WebAuthn library just minted, so it can be spent
 * exactly once later.
 *
 * **Only the hash is stored.** The plain challenge lives in the options object
 * going out to the browser and nowhere else — same house rule as
 * `sesiones.token_hash` and `token_uso_unico.token_hash`, and for the same
 * reason: a database dump should prove nothing.
 *
 * **`id_usuario` and `id_sesion` are required parameters that accept null**,
 * rather than optional ones. The passwordless ceremony genuinely has neither,
 * so both have to be expressible — but if they were omissible, "this ceremony
 * has no owner" and "I forgot to pass the owner" would look identical at the
 * call site, and only one of those is meant to reach the database. Making the
 * caller type `null` is the difference between a decision and an oversight.
 */
export async function guardarReto(
  reto: string,
  proposito: PropositoReto,
  contexto: {
    id_usuario: number | null;
    id_sesion: string | null;
    transaction?: Transaction;
  },
): Promise<void> {
  await RetoWebauthnModel.create(
    {
      reto_hash: hashOpaqueToken(reto),
      proposito,
      id_usuario: contexto.id_usuario,
      id_sesion: contexto.id_sesion,
      // Computed from the process clock, not Postgres's `now()`. Deliberate
      // and the same call `crearToken` makes: the API and the database run on
      // the same host, so drift between the two clocks is milliseconds against
      // a two-minute margin. If Postgres ever moves to its own machine, this
      // is the assumption that needs revisiting.
      expires_at: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
    { transaction: contexto.transaction },
  );
}

/**
 * Spend a challenge, and say who it belonged to — or `null` if it cannot be
 * spent, for any reason at all.
 *
 * 🔴 **One statement, and that is the entire anti-replay guarantee.** The
 * write that marks the row spent is the same statement that checks it is still
 * unspent, so two requests carrying the same captured assertion cannot both
 * pass: one updates the row, the other matches nothing. Written as a `SELECT`
 * followed by an `UPDATE` — which reads more naturally and is what somebody
 * will eventually propose — both requests read "unspent" and both proceed.
 * That is finding B6, already made once in this repository, and
 * `gastarCodigo`, `sellarPaso` and `consumirToken` are all shaped this way
 * because of it.
 *
 * 🔴 **And for a synced passkey there is no second line of defence behind
 * this one.** iCloud Keychain and Google Password Manager report a signature
 * counter of 0 forever, so `esContadorDeClon` can never catch a clone of one —
 * see its own comment. This statement is what stops a replayed assertion, on
 * its own, for the credentials most people will actually use.
 *
 * **`null` for every failure, without saying which.** Expired, already spent,
 * wrong purpose, wrong session, never existed — one answer. Rule B12, which
 * `consumirToken` already applies: a caller who can tell "expired" from "never
 * existed" can map what exists.
 *
 * **`id_sesion` is required and accepts null, for a sharper reason than in
 * `guardarReto`.** If it were optional, forgetting it would drop the condition
 * from the `WHERE` entirely — and a challenge minted for one session would
 * become spendable from any session that got hold of it. An omitted parameter
 * must not be able to widen a security check.
 *
 * **How `null` reaches SQL, measured rather than assumed.** Sequelize renders
 * `{ id_sesion: null }` as `"id_sesion" IS NULL`, not as `= NULL` — verified
 * against this project's own Sequelize by generating the statement and reading
 * it back. It matters because `= NULL` is never true in SQL, so the
 * passwordless ceremony — the one case where both sides are null — would fail
 * one hundred per cent of the time, and fail *silently*, looking exactly like
 * a wrong challenge. 🔴 The trap is real and it is one refactor away: rewrite
 * this as raw SQL with `id_sesion = $n` and it comes back. Raw SQL here needs
 * `IS NOT DISTINCT FROM`.
 */
export async function consumirReto(
  reto: string,
  proposito: PropositoReto,
  contexto: {
    id_sesion: string | null;
    transaction?: Transaction;
  },
): Promise<{ id_usuario: number | null; id_sesion: string | null } | null> {
  const [count, rows] = await RetoWebauthnModel.update(
    { used_at: new Date() },
    {
      where: {
        reto_hash: hashOpaqueToken(reto),
        // Inside the `WHERE`, never checked afterwards: a challenge minted to
        // register a credential must not be redeemable completing an
        // authentication, and a check that happens after the row is already
        // marked spent has already lost.
        proposito,
        id_sesion: contexto.id_sesion,
        used_at: null,
        expires_at: { [Op.gt]: new Date() },
      },
      returning: true,
      transaction: contexto.transaction,
    },
  );
  if (count === 0) return null;
  const row = rows[0].dataValues;
  return { id_usuario: row.id_usuario, id_sesion: row.id_sesion };
}

/**
 * Delete rows nothing can redeem any more: spent, or expired.
 *
 * Opportunistic rather than scheduled, same as `purgeExpiredTokens` — called
 * fire-and-forget from the ceremony itself, with its error logged rather than
 * propagated, because failing to tidy up must never fail a login.
 *
 * **Deliberately not folded into `purgeExpiredSessions`.** That sweep uses a
 * single 30-day cutoff over `sesiones`, which is the table `authenticate`
 * reads on every request in the ERP; these rows die after two minutes and
 * live in a table nothing on the hot path touches. Sharing the sweep would
 * mean either keeping challenges for thirty days or making the session purge
 * run far more often than it needs to.
 */
export async function purgarRetosCaducados(): Promise<number> {
  return RetoWebauthnModel.destroy({
    where: {
      [Op.or]: [{ used_at: { [Op.ne]: null } }, { expires_at: { [Op.lte]: new Date() } }],
    },
  });
}
