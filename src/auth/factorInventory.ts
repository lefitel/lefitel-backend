// What an account already has to prove a second factor with — and what does
// not count, on purpose.
//
// Two rules live here because a shortcut through either one turns onboarding,
// and later `requireStepUp`, into theatre:
//
// - An unconfirmed TOTP secret is not a factor. Generating one only proves a
//   QR code was drawn, not that anybody scanned it — the screen could have
//   been photographed wrong, or abandoned halfway. Counting it would let a
//   session pass a gate it cannot actually satisfy: nobody can type a code
//   back for a secret they never captured.
// - Recovery codes are the way back in when a real factor is unreachable, not
//   a factor of their own. They are handed out at the *end* of registering
//   one, precisely because that assumes one already exists. Counting them
//   here would let onboarding — and later, `requireStepUp` — finish with
//   nothing but a sheet of paper, which is the exact hole the second factor
//   was built to close.
//
// The three tables this file queries are empty until a later plan starts
// writing to them: registering a passkey, confirming a TOTP secret, issuing
// recovery codes. So today this returns zero for everybody — that is not a
// stub, it is the correct answer for an account that has genuinely
// registered nothing, and the two rules above are exercised by the tests
// beside this file rather than left for the day rows finally appear.

import { Op } from "sequelize";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { CodigoRecuperacionModel } from "../models/codigoRecuperacion.model.js";
import { MFA_GRACE_DAYS } from "../config/security.js";
import type { EstadoSesion } from "./sessionState.js";

const DIA_MS = 24 * 60 * 60 * 1000;

/** The raw inventory: how many of each thing this account has registered. */
export interface InventarioFactores {
  passkeys: number;
  totp: number;
  codigos: number;
}

/**
 * The raw inventory: how many of each thing this account has registered.
 *
 * `totp` already excludes an unconfirmed secret — the query asks for
 * `confirmed_at IS NOT NULL` directly, so the exclusion lives in the one
 * place nobody reading this later could skip by accident. `codigos` counts
 * *unredeemed* codes only (`used_at IS NULL`), which is the number worth
 * showing somebody deciding whether to generate a fresh batch. `passkeys` is
 * a plain count: every row here already went through a WebAuthn ceremony
 * that proved possession, so there is no confirmation step left to ask for.
 */
export async function factoresDe(id_usuario: number): Promise<InventarioFactores> {
  const [passkeys, totp, codigos] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } } }),
    CodigoRecuperacionModel.count({ where: { id_usuario, used_at: null } }),
  ]);
  return { passkeys, totp, codigos };
}

/**
 * Whether this account has anything `requireStepUp` may accept in place of
 * the current password.
 *
 * Deliberately `passkeys > 0 || totp > 0` and nothing else — the second rule
 * this file exists to enforce is that recovery codes never join that `||`.
 *
 * Queries the two relevant tables directly rather than calling `factoresDe`
 * and discarding its `codigos` count: this runs on the hot path of every
 * gated write `requireStepUp` guards, and a third COUNT this function has no
 * use for is a third round trip charged to every one of them. `factoresDe`
 * keeps all three, for callers that actually want the full inventory (a
 * settings screen showing "2 passkeys, no TOTP, 5 recovery codes left").
 * Both share the same confirmed-only TOTP rule, each in its own query, since
 * there is no third function here for one copy of it to live in without one
 * of these two calling the other and paying for a table it does not need.
 */
export async function tieneAlgunFactor(id_usuario: number): Promise<boolean> {
  const [passkeys, totp] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } } }),
  ]);
  return passkeys > 0 || totp > 0;
}

/**
 * What state a session opens in, and whether this login is the one that has to
 * start the fourteen-day clock.
 *
 * **This answer is a photograph, and its twin is `estadoEfectivo` in
 * `auth/sessionState.js`.** What this function decides is written into the
 * session row once and never rewritten, so on its own it imposes the deadline
 * only on people who log in after it. `authenticate` recomputes the part that
 * can go stale on every request. Read them together: this one is the full
 * decision and pays for the factor queries below; that one is the free half,
 * and works from the session row alone.
 *
 * **What plan 4B has to know, because getting it wrong here is a lockout.**
 * `mfa_grace_until` is stamped once and **never cleared** — see `graceUntil`
 * below: the branch for an account that already has a factor returns `null`,
 * which means "leave the column alone", not "clear it". So once a deadline is
 * in the past it stays in the past, on every account, including the ones that
 * went and registered a factor afterwards.
 *
 * That is why `estadoEfectivo` does **not** narrow on the stamp alone. When the
 * endpoint that verifies a factor promotes a session to `completa`, two things
 * on the row keep it there, and the promotion is only one of them:
 *
 * - the session was opened after the deadline had already gone by — the case
 *   for anybody who registers a factor *after* their own deadline, and the one
 *   clause that needs nothing from 4B at all; or
 * - the row carries `mfa_satisfied_at` or `mfa_source`, which the endpoint that
 *   proved the factor should be writing anyway. **Skipping them does not just
 *   affect this**: `requireStepUp` reads `mfa_satisfied_at` and would refuse
 *   the next gated write on a session that had just authenticated.
 *
 * **And a second duty 4B owns, this one not optional.** The endpoint that
 * removes an account's *last* factor — deleting a passkey, unlinking TOTP, both
 * of which the specification calls for — has to revoke or demote that account's
 * live sessions. `estadoEfectivo`'s third clause reads `mfa_satisfied_at` and
 * `mfa_source`, which record that a factor was proved **at the time**, and
 * nothing walks them back: a session opened while the account had a factor goes
 * on holding the whole ERP for up to `SESSION_ABSOLUTE_DAYS` after the last one
 * is deleted. Only the next login answers `onboarding`. That is not something
 * this function can fix from here — knowing it would mean counting factors on
 * every request, which is the cost this whole design refuses — so it belongs to
 * the endpoint that causes it, at the moment it causes it.
 *
 * **And the tidying that is worth doing even though nothing depends on it:**
 * clear `usuarios.mfa_grace_until` when an account registers its first factor.
 * The first branch below already says a date in that column "reads as: this
 * account is still being chased", and after registration it is not. Third line
 * of defence, not the first.
 *
 * `graceUntil` is an instruction to the caller, not a fact about the account:
 * a date means "write this into `usuarios.mfa_grace_until`", `null` means
 * "leave that column alone". It is returned rather than written here because
 * the write must not happen until the session actually exists — see the call
 * site in `auth.controller.ts` for what starting somebody's fourteen days on a
 * request that ended in a 503 would cost them.
 *
 * Three branches, in this order, and the order is the load-bearing part:
 *
 * 1. **There is a factor to prove** → `parcial`. The password got them this
 *    far and no further. First, so that somebody who *has* a passkey is asked
 *    to use it rather than sent to a setup screen for a factor they already
 *    registered.
 * 2. **No usable deadline stored** → stamp one, and `completa`. Started at
 *    their first login *after* the deploy rather than filled in by the
 *    migration: from the deploy, somebody on holiday comes back on day 30 to a
 *    grace period that expired without them ever seeing a screen.
 * 3. **Deadline still ahead** → `completa`. **Deadline reached or passed** →
 *    `onboarding`: they get in, and the ERP answers 403 until they configure
 *    something.
 *
 * **Nobody is ever refused.** There is no fourth answer and no throw of this
 * function's own — "el día 15 existe y no echa a nadie". Day 15 is a screen
 * that says what to do, not a closed door, because a technician in the field
 * on day 15 would otherwise get a generic red toast with no button and no
 * instruction.
 *
 * **A verified email deliberately does not appear here.** The specification
 * says both that `onboarding` means "todo lo demás: 403" and, three paragraphs
 * later, that in `onboarding` "se puede trabajar"; those cannot both hold, and
 * the rule this plan settled on is that email verification closes step-up
 * operations rather than the state of the session. Requiring it here would put
 * the whole payroll — who today have neither an email nor a factor — in front
 * of a setup screen on deploy day, which is the outcome the specification
 * spends two paragraphs avoiding.
 *
 * ---
 *
 * ⚠️ **`parcial` is a dead end until the plan after this one, and this is the
 * comment for whoever deploys.** Reaching it needs a row in
 * `credencial_webauthn` or a confirmed one in `factor_totp`, and as of this
 * plan nothing anywhere in `src/` inserts into either — the only statements
 * against those tables are the COUNTs in this file, and neither migration
 * seeds a row. So on deploy day `tieneAlgunFactor` is false for every account
 * and this branch cannot fire.
 *
 * That matters because there is nothing on the other side of it yet.
 * `sessionState.ts` allows a `parcial` session to reach `/api/auth/mfa` and
 * `/api/auth/webauthn/login`, and **neither route is mounted** — `auth.routes.ts`
 * has no `/mfa` and no `/webauthn/*`. Anybody who did land in `parcial` today
 * would hold a session that can log out and read `/me` and nothing else, with
 * no endpoint anywhere in the API able to lift them out of it, on every login,
 * permanently.
 *
 * **So the ordering is a hard constraint, not a preference: the endpoint that
 * verifies a factor has to be live before, or in the same deploy as, the first
 * endpoint that registers one.** Shipping registration first locks out
 * whoever registers first — starting with whoever tests it.
 *
 * ⚠️ **And `onboarding` is the branch that fires on its own — read this one
 * before deploying.** `parcial` above cannot happen today. This one happens to
 * **everybody**, deterministically, `MFA_GRACE_DAYS` after each account's own
 * first login. No row has to be inserted and nobody has to do anything: the
 * clock this function starts runs out by itself.
 *
 * When it does, the login still answers 200 and the cookie is still set — and
 * then `authenticate` refuses everything outside the allowlist in
 * `sessionState.ts`. The six extra doors `ONBOARDING_EXTRA` opens are the way
 * out, and **four of them are not mounted**: `auth.routes.ts` has no `/totp`,
 * no `/webauthn/register`, no `/webauthn/credentials` and no
 * `/recovery-codes`. The two that are mounted, `/email` and `/sessions`,
 * cannot register a factor, and a registered factor is the only thing that
 * changes this answer. So there is no way out of `onboarding` from inside the
 * API until plan 4B ships one.
 *
 * **The deadline this commit creates: 4B has to be live within
 * `MFA_GRACE_DAYS` of this deploy.** Not "soon" — fourteen days from the day
 * each person first logs in, and the earliest of those is the day of the
 * deploy itself.
 *
 * **The manual reprieve, if that date is going to be missed:**
 *
 * ```sql
 * UPDATE usuarios SET mfa_grace_until = NULL;
 * ```
 *
 * That is not a workaround, it is this function's own first branch: a null
 * deadline is the "never started" case, so each account's next login stamps a
 * fresh `MFA_GRACE_DAYS` and everybody is back to `completa`. It buys another
 * full grace period and can be run as many times as needed. Note it re-stamps
 * on *login*, not on the UPDATE, so somebody who does not log in again stays
 * out until they do.
 */
export async function estadoInicialDeSesion(
  // `undefined` as well as `null`, and spelled out rather than left to
  // `strict: false` to permit it silently: `IUsuario` declares
  // `mfa_grace_until?: Date | null`, so an account object assembled without
  // the key is a normal caller of this function and not a mistake.
  usuario: { id: number; mfa_grace_until: Date | null | undefined },
  ahora: Date,
): Promise<{ estado: EstadoSesion; graceUntil: Date | null }> {
  if (await tieneAlgunFactor(usuario.id)) {
    // No deadline is stamped on them: they have nothing left to be given
    // fourteen days for, and a date in that column reads as "this account is
    // still being chased".
    return { estado: "parcial", graceUntil: null };
  }

  // **`Number.isNaN` is the guard that matters here; the loose `== null` is
  // only a shortcut.** Tightening it to `=== null` changes no behaviour and
  // fails no test — `undefined` would fall through to `new Date(undefined)`,
  // which is an Invalid Date, whose `getTime()` is NaN, which lands in exactly
  // the same branch. Said plainly because the first version of this comment
  // claimed the opposite and a review caught it.
  //
  // What the NaN branch is actually for is any deadline this function cannot
  // read: absent (`IUsuario` declares the column optional, so an account
  // object built without the key is a normal caller), or stored as something
  // unparseable. Both are treated as "never started", so a fresh deadline is
  // stamped. That is the safe direction to be wrong in: it costs the account
  // another `MFA_GRACE_DAYS`, where falling through to a comparison against
  // NaN — every one of which is false — would return `completa` with nothing
  // to write, on every login for ever, and the ERP would never close.
  const limite = usuario.mfa_grace_until == null ? NaN : new Date(usuario.mfa_grace_until).getTime();
  if (Number.isNaN(limite)) {
    return { estado: "completa", graceUntil: new Date(ahora.getTime() + MFA_GRACE_DAYS * DIA_MS) };
  }

  // `<=` and not `<`: the stored instant is when the grace is over, so a login
  // at exactly that millisecond is already past it.
  return { estado: limite <= ahora.getTime() ? "onboarding" : "completa", graceUntil: null };
}
