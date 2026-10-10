// What an account already has to prove a second factor with — and what does
// not count, on purpose.
//
// 🔴 **Two questions live here, and since plan 4E they have different
// answers.** Until then every caller asked the same thing — "is there a
// passkey or a confirmed TOTP?" — and one function served them all. A verified
// email address is now a factor (`tieneAlgunFactor`), and it is *not* a
// credential (`tieneCredencialRegistrada`). Three audits of that plan found
// the same hole by three different roads: code that asks about **credentials**
// — the passwordless login's "was the key deleted under me" guard, the "last
// credential removed" tails of `deleteTotp` and `deleteCredential`, the rescue
// console's wording — must not start answering `true` because an address was
// verified. And code that asks about **factors** — which state a session opens
// in, whether `requireStepUp` refuses, whether recovery codes may be minted or
// spent — must. Each caller names the question it means; a new caller picks
// one and says why.
//
// Two rules that predate that split still hold, because a shortcut through
// either one turns onboarding, and later `requireStepUp`, into theatre:
//
// - An unconfirmed TOTP secret is not a factor. Generating one only proves a
//   QR code was drawn, not that anybody scanned it — the screen could have
//   been photographed wrong, or abandoned halfway. Counting it would let a
//   session pass a gate it cannot actually satisfy: nobody can type a code
//   back for a secret they never captured. **A verified address is the
//   opposite case**: verifying it *is* typing something back — a link that
//   only that mailbox received — so the row already carries the proof an
//   unconfirmed secret lacks.
// - Recovery codes are the way back in when a real factor is unreachable, not
//   a factor of their own. They are handed out at the *end* of registering
//   one, precisely because that assumes one already exists. Counting them
//   here would let onboarding — and later, `requireStepUp` — finish with
//   nothing but a sheet of paper, which is the exact hole the second factor
//   was built to close. (Since 4E an account whose only factor is its email
//   may hold codes too: they are its way back in when the mailbox is not.)
//
// The tables this file queries are read on every login and every gated write,
// so a change here changes who gets through a gate today rather than on some
// future deploy day.

import { Op, type Transaction } from "sequelize";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { CodigoRecuperacionModel } from "../models/codigoRecuperacion.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { MFA_GRACE_DAYS, mfaObligatorio } from "../config/security.js";
import { totpEstaDisponible } from "./mfaKeyCheck.js";
import type { EstadoSesion, FuenteEnElLogin } from "./sessionState.js";

const DIA_MS = 24 * 60 * 60 * 1000;

/** The raw inventory: how many of each thing this account has registered. */
export interface InventarioFactores {
  passkeys: number;
  totp: number;
  codigos: number;
  /** `1` when the account's address is verified, `0` otherwise — a factor since plan 4E. */
  correo: 0 | 1;
}

/**
 * Whether this account's address is verified — the fourth thing a factor can
 * be, since plan 4E.
 *
 * **`findByPk` with one attribute, and not `count`.** The obvious query is
 * `UsuarioModel.count({ where: { id, email_verified_at: { [Op.ne]: null } } })`,
 * and it would be wrong for a reason that has nothing to do with SQL:
 * `app.auth.test.ts` spies `UsuarioModel.count` once and shares that spy with
 * `deleteRol`'s "is this role still in use" check, so the two unrelated
 * questions would ride one fixture and the "no factor" tests in that file
 * would keep passing for whatever answer the role check happened to need.
 * Reading the column is also what `authenticate` and `/auth/me` already do
 * with this model, so the fake tables in the tests have a shape to follow.
 *
 * `paranoid: true` on the model means an archived account reads as `null`
 * here, and `null` is "no factor": an archived account has nothing to prove.
 */
async function correoVerificado(
  id_usuario: number,
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  const fila = await UsuarioModel.findByPk(id_usuario, {
    attributes: ["email_verified_at"],
    transaction: opciones.transaction,
  });
  return fila?.dataValues.email_verified_at != null;
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
 * `correo` is the verified address as a `0 | 1`, so that callers summing or
 * comparing the inventory treat it like the others.
 */
export async function factoresDe(id_usuario: number): Promise<InventarioFactores> {
  const [passkeys, totp, codigos, correo] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } } }),
    CodigoRecuperacionModel.count({ where: { id_usuario, used_at: null } }),
    correoVerificado(id_usuario),
  ]);
  return { passkeys, totp, codigos, correo: correo ? 1 : 0 };
}

/**
 * Whether this account has a **credential** registered: a passkey or a
 * confirmed TOTP secret. Not the same question as `tieneAlgunFactor` below,
 * and the header of this file says why the two split.
 *
 * This is what `tieneAlgunFactor` used to be, under the name that says what it
 * counts. Ask it when the question is about the *credential rows*: the
 * passwordless login checking that the key it just verified still exists
 * (`terminarLogin`'s `factor-desaparecido` guard), `deleteTotp` and
 * `deleteCredential` deciding whether the row they removed was the last one,
 * the rescue console describing what it just deleted. A verified address is
 * none of those things, and answering `true` for it here would have let a
 * deleted key open a session, and left a remembered-device cookie alive after
 * the credential it trusted was gone.
 *
 * Deliberately `passkeys > 0 || totp > 0` and nothing else — recovery codes
 * never join that `||`, for the reason the header gives.
 */
export async function tieneCredencialRegistrada(
  id_usuario: number,
  /**
   * The caller's transaction, so that a login that already holds one runs
   * these two counts on the same connection instead of borrowing a second
   * from the pool while the first sits waiting — with `max: 15`, fifteen
   * such logins at once would starve the whole API. Optional and normally
   * absent: `deleteCredential` and `deleteTotp` in particular must NOT pass
   * one, so that they count committed state and never the row they are in
   * the middle of removing.
   */
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  const { transaction } = opciones;
  const [passkeys, totp] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario }, transaction }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } }, transaction }),
  ]);
  return passkeys > 0 || totp > 0;
}

/**
 * Whether this account has anything `requireStepUp` may accept in place of
 * the current password — a credential, **or a verified address**.
 *
 * This is the question that decides which state a session opens in
 * (`estadoInicialDeSesion`), whether the gate refuses at all, and whether
 * recovery codes may be minted or spent. Since plan 4E a verified email is a
 * factor on its own (Isaias, 2026-09-03: automatic, on a par with the app and
 * the key, complete), so an account that has verified its address and nothing
 * else opens `parcial` and is asked for a code by email — and at the step-up
 * gate it stops being answerable with the password alone: it has a factor now,
 * so the gate demands that factor proved recently.
 *
 * Three reads, in parallel, and none of them `factoresDe`: this runs on the
 * hot path of every gated write, and the recovery-code count that function
 * also pays for has no bearing on the answer.
 */
export async function tieneAlgunFactor(
  id_usuario: number,
  /** Forwarded to every read — see `tieneCredencialRegistrada` for the pool. */
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  const [credencial, correo] = await Promise.all([
    tieneCredencialRegistrada(id_usuario, opciones),
    correoVerificado(id_usuario, opciones),
  ]);
  return credencial || correo;
}

/**
 * The other question, and it is **not** the same one: does this account have a
 * factor it could actually prove *right now*?
 *
 * A confirmed `factor_totp` row whose key is unavailable answers `true` to
 * `tieneAlgunFactor` and `false` here, and the gap between those two answers
 * is a person locked out. `totp.routes.ts:14-26` left
 * `requireTotpKeyAvailable` off `DELETE /auth/totp` on purpose — its own words,
 * "para que una llave equivocada no encierre a nadie en un factor muerto" — and
 * then mounted `requireStepUp` on it, which demands proof of that same dead
 * factor. Two pieces each correct on their own; the seam between them is the
 * lockout. This function is what lets the seam be closed without touching
 * `tieneAlgunFactor`.
 *
 * 🔴 **And `tieneCredencialRegistrada` — and `tieneAlgunFactor`, which reads
 * it — are deliberately left alone.** Teaching either to skip an unreadable
 * TOTP looks like the same fix and is a far worse hole: `estadoInicialDeSesion`
 * below reads `tieneCredencialRegistrada` to decide what state a session
 * opens in, and `requireStepUp` reads `tieneAlgunFactor` to decide whether to
 * refuse at all. A mistyped `MFA_ENCRYPTION_KEY_ACTIVE` would then open
 * **every** session as if nobody had a second factor at all — a configuration
 * typo turned into a silent, fleet-wide downgrade. The narrow question belongs
 * in its own function, asked only by the one route that needs it.
 *
 * **Passkeys are unconditionally verifiable**: nothing about them is encrypted
 * with the TOTP keyring, so a broken key does not touch them. Which is also
 * why the answer is not simply `!totpEstaDisponible()` — an account holding a
 * passkey *and* an unreadable TOTP can still prove itself, and must still be
 * asked to. **And so is a verified address, since plan 4E**: the code goes by
 * email, and the keyring has nothing to do with it. Which closes the seam
 * this function was written for in one more way — an account whose only
 * credential is a TOTP nobody can decrypt used to have no way to prove itself
 * short of the rescue console; with a verified address it has the email code.
 */
export async function hayFactorVerificable(id_usuario: number): Promise<boolean> {
  const [passkeys, totp, correo] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } } }),
    correoVerificado(id_usuario),
  ]);
  return passkeys > 0 || (totp > 0 && totpEstaDisponible()) || correo;
}

/**
 * What somebody may actually type — or press a finger on — to satisfy a
 * step-up refusal right now.
 *
 * **Why it exists.** `requireStepUp` refuses with `sin-factor-reciente`, which
 * means "prove a factor" and names none. Until passkeys existed that was
 * enough, because there was exactly one thing to prove and the window could
 * hard-code a six-digit field. Now there are two, they look nothing alike on
 * screen, and the window has no way to know which to draw. Guessing wrong is
 * not cosmetic: an account whose only factor is a passkey gets a form asking
 * for a code that cannot exist, five wrong tries lock the account, and the
 * remedy is behind the very gate that is refusing.
 *
 * **Different question from `tieneAlgunFactor`, and the difference is
 * `codigo`.** That function answers "does this account have a *factor*", which
 * decides whether the gate refuses at all, and recovery codes deliberately do
 * not count towards it — the header of this file says why. This one answers
 * "what may this person offer to cover the refusal", and `/api/auth/stepup`
 * accepts a recovery code, so leaving it out would hide a remedy the server
 * already honours. The two never contradict each other in practice: an account
 * holding nothing but codes never reaches this refusal, because
 * `tieneAlgunFactor` sends it down the password branch instead.
 *
 * 🔴 **Which is exactly why this is not called `factores`.** The header of this
 * file spends a paragraph establishing that a recovery code is *not* a factor,
 * because counting it as one would let onboarding finish with nothing but a
 * printed sheet. A list named `factores` with `"codigo"` inside it walks that
 * back on the wire, and the next person to read the response would be right to
 * conclude the rule had been dropped. `metodos` claims only what it is: the
 * ways this person may re-prove themselves at a window that is already open.
 *
 * **`totp` carries the keyring rule, and that is not tidiness.** A confirmed
 * secret this process cannot decrypt is a form that can never be completed;
 * naming it here would send somebody to type six digits at a 503. Same
 * condition as `hayFactorVerificable` above, in the same file, so the two
 * cannot drift apart — and the same reason passkeys carry no such condition:
 * nothing about them is encrypted with that keyring.
 *
 * **What that rule does *not* cover, said plainly.** `totpEstaDisponible` is a
 * module-level flag set once, at boot, by `comprobarLlaveAlArrancar`. A keyring
 * that becomes unreadable while the process is running still reports `true`, and
 * so does one that can read most rows but not a particular `key_version`. In
 * either case this names `"totp"`, the person types six digits, and the answer
 * is the ordinary "código incorrecto" — no charge, no lockout, and no end.
 * Inherited from `hayFactorVerificable` rather than introduced here, and the fix
 * belongs there if it is ever worth making.
 *
 * **The order is load-bearing.** The client renders the options in the order
 * they arrive, and a passkey is one gesture where a code is a device, an app
 * and a transcription. `correo` sits after `totp`: an app code is on the
 * phone already, an email code has to be requested and waited for. Recovery
 * codes come last on purpose: they are the way back in, not a method, and
 * each one spent is one fewer.
 *
 * **`correo` since plan 4E**, on a par with the others by decision: the window
 * offers "send me a code" whenever the address is verified, even beside a
 * passkey or an app — a person whose phone is at home enters from the PC by
 * email. Isaias declined the alternative (hide the email once a stronger
 * factor exists) and the security notice that would have marked the weaker
 * path; the bitácora line carries `fuente: "correo"`, and that is the record.
 *
 * 🔴 **And this is `factoresDe`'s first live caller.** Its own docblock, and
 * the note in `estadoInicialDeSesion` below, gave that function an expiry
 * date: become somebody's query or be deleted along with its interface and
 * tests. This is the query. What it is not is the settings screen that
 * docblock imagined — that screen still does not exist, and the count of
 * unspent codes it wanted is deliberately dropped here, because a refusal
 * naming how many codes are left tells a stolen cookie how much runway it has.
 *
 * **And since 9 October 2026 it has a second caller: `GET /api/auth/me`, for a
 * `parcial` session.** Plan 4E's first draft sent this list to such a session
 * on the login body and the audit named it what it was — the factor inventory
 * handed to whoever holds only the password — so it was withheld. Isaias
 * reversed that with the cost stated, because the second-step screen cannot
 * offer the right way in without it; the reasoning is on the handler.
 */
export type MetodoReautenticacion = "passkey" | "totp" | "correo" | "codigo";

export async function metodosDeReautenticacion(
  id_usuario: number,
): Promise<MetodoReautenticacion[]> {
  const inventario = await factoresDe(id_usuario);
  const metodos: MetodoReautenticacion[] = [];
  if (inventario.passkeys > 0) metodos.push("passkey");
  if (inventario.totp > 0 && totpEstaDisponible()) metodos.push("totp");
  if (inventario.correo > 0) metodos.push("correo");
  if (inventario.codigos > 0) metodos.push("codigo");
  return metodos;
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
 * 🔴 **And the tidying that looked worth doing, was done, and had to be
 * undone.** For a week, confirming a factor cleared `usuarios.mfa_grace_until`
 * — from `confirmTotp`, `registerVerify` and `verifyEmail` — on the grounds
 * that the first branch below says a date in that column "reads as: this
 * account is still being chased", and after registration it is not. It also
 * made the deadline renewable at will: NULL is read here as "the clock never
 * started", so registering a factor and deleting it again bought a whole new
 * `MFA_GRACE_DAYS` at the next login, indefinitely, and registering a passkey
 * needs no mailbox. Nothing clears the column any more, and nothing may: see
 * the tombstone at the foot of `sessionPromotion.ts`. The stamp is written
 * once and stays, which is what makes the second branch below fire exactly
 * once in an account's life.
 *
 * ~~A decision 4B has to take rather than inherit: `factoresDe` and
 * `InventarioFactores` have no caller anywhere in `src/`.~~ **Settled by plan
 * 4C:** `metodosDeReautenticacion` above is that caller, and `requireStepUp`
 * calls it on every `sin-factor-reciente` refusal. What it is *not* is the
 * settings screen `factoresDe`'s own docblock imagined — that screen still
 * does not exist. The rule that produced this note stands for the next
 * function somebody is tempted to leave lying about: code that describes a
 * screen nobody has built is a promise with an expiry date.
 *
 * `graceUntil` is an instruction to the caller, not a fact about the account:
 * a date means "write this into `usuarios.mfa_grace_until`", `null` means
 * "leave that column alone". It is returned rather than written here because
 * the write must not happen until the session actually exists — see
 * `terminarLogin` in `auth/finishLogin.ts` for what starting somebody's
 * fourteen days on a request that ended in a 503 would cost them.
 *
 * **`conFactor` says which branch answered, and it is there because two of
 * them can agree.** Branch 1 (a factor exists, the login covered it) and
 * branch 3 (no factor, deadline still ahead) both answer `completa` with no
 * deadline. The passwordless login has to refuse the second — it means the
 * credential it just verified was deleted under the ceremony — and could not
 * tell them apart from the state alone. A review found the guard it had
 * written on `estado` and `graceUntil` passing exactly that case.
 *
 * **`conCredencial` is the narrower witness that guard actually needs, since
 * plan 4E.** With a verified email counting as a factor, `conFactor` is `true`
 * for every account that has verified its address — whether or not the
 * passkey the ceremony just verified still exists. The guard is about the
 * *credential*: it reads `conCredencial`, which comes from
 * `tieneCredencialRegistrada` and ignores the address. Both are returned
 * rather than one, because branch 1 fires on either and the answer has to
 * say which: `conFactor` has no reader in `src/` today — the tests read it,
 * as the branch's own statement of why it fired — and it stays because a
 * caller that needs "did branch 1 fire" and is handed only `conCredencial`
 * would reconstruct it wrong. The header of this file says why the two
 * questions split.
 *
 * **`fuenteEnElLogin` — what, if anything, already covered the second factor
 * during this login.** Two values are possible, and they are the two
 * credentials checked *during* a login rather than after it: `"dispositivo"`,
 * a live "remember this device" cookie the caller already resolved for this
 * account (plan 4B's Task 12, Decision 4 — see `comprobarDispositivo`), and
 * `"passkey"`, the passwordless ceremony of plan 4C's phase 2, where the
 * assertion the caller just verified *is* the factor. It used to be a boolean
 * named for the first of those; the second gave it a name that says what was
 * proved rather than which caller is asking. `undefined` means "nothing was",
 * so every caller written before this parameter existed keeps behaving
 * exactly as it did.
 *
 * **This function stays the *only* place that answers "which state does this
 * session open in", which is why the source is a parameter here rather than a
 * second decision made in `login` or in the passwordless controller.** The
 * obvious-looking alternative — `estadoInicialDeSesion` returns `parcial` as
 * it always did, and the controller overwrites that to `completa` when it
 * knows better — puts two places in charge of one question, and the failure
 * mode is not hypothetical: hallazgo D2 is exactly a function computing this
 * and a second one recomputing it without knowing that the first one already
 * had. So the source comes in here, is read in exactly one branch (the first),
 * and nowhere else in `src/` decides `estado` on its own account.
 *
 * **The source only ever matters inside branch 1, below, and that placement is
 * itself part of the contract — for both values.** An account with nothing
 * registered has nothing for a remembered device to skip, so `"dispositivo"`
 * must not be consulted before `tieneAlgunFactor` — reading it first would
 * short-circuit straight to `completa` with no `graceUntil` stamped, silently
 * cancelling the fourteen-day clock for an account that has never even been
 * asked to configure anything. `"passkey"` is kept in the same place rather
 * than given a shortcut of its own, even though the caller has just verified
 * a credential of this very account: the count is a second, independent
 * witness that the credential is still there, and the passwordless controller
 * treats any answer but `completa`-with-no-deadline as "it was deleted under
 * me" and refuses — see its own comment for the race that makes that matter.
 * A shortcut here would turn that witness into a precondition the caller has
 * to remember to satisfy.
 *
 * **What this function does not do, and whose job that is instead.** It never
 * calls `comprobarDispositivo` itself, never verifies an assertion, and never
 * writes `sesiones.mfa_source` or `mfa_satisfied_at`. The caller resolves the
 * credential — strictly *after* the password has already checked out, or
 * after the signature verified, never before (resolving whose device a cookie
 * names ahead of the password is the exact trap `comprobarDispositivo`'s own
 * header warns against). Both doors reach here through `terminarLogin`
 * (`auth/finishLogin.ts`), which hands the same source on to `createSession`:
 * that is where `mfa_source` is written, and where `mfa_satisfied_at` is
 * stamped from it — see `esPruebaDeFactor` in `sessionState.ts` for the one
 * rule that decides which sources count. An earlier version of this paragraph
 * said the column could not be written yet and that nothing depended on it;
 * both stopped being true with plan 4C's phase 2.
 *
 * Three branches, in this order, and the order is the load-bearing part:
 *
 * 1. **There is a factor to prove** → `parcial`, **unless this login already
 *    covered it, which opens `completa` instead.** A valid remembered device
 *    is Decision 4's whole point: this account has something to prove, and
 *    this browser already proved it once and asked not to be asked again. A
 *    verified passkey assertion is the factor itself, proved a moment ago.
 *    Checked first, so that somebody who *has* a passkey but no remembered
 *    device is still asked to use it rather than sent to a setup screen for a
 *    factor they already registered.
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
 * **A verified email counts here since plan 4E, and the paragraph that used
 * to say the opposite is worth keeping in view.** It argued that requiring the
 * address as a *precondition* would put the whole payroll in front of a setup
 * screen on deploy day. That is still true and still avoided: nobody is
 * *required* to verify anything to get in. What changed is the other
 * direction — an address, once verified, is enough to be asked for a second
 * factor, because the code by email is one. So an account with no verified
 * address takes branch 2 exactly as before; the day it verifies one,
 * `verifyEmail` promotes that session — and leaves the deadline exactly where
 * it found it, see the paragraph above — and its next login opens `parcial`
 * and asks for a code. The way out of `parcial` for that account —
 * `/mfa/email-code` and `/mfa/verify` with `metodo: "correo"` — shipped in the
 * same deploy, for the reason the constraint below gives.
 *
 * ---
 *
 * ✅ **`parcial` was a dead end when this was written; it is not any more, and
 * this is still the comment for whoever deploys.** Reaching it needs a row in
 * `credencial_webauthn` or a confirmed one in `factor_totp`, and both are now
 * written — `registerVerify` and `confirmTotp`. What made that safe is that
 * the doors out are mounted too: `app.ts` mounts `/api/auth/mfa` and
 * `/api/auth/webauthn`, and `sessionState.ts` opens both prefixes to
 * `parcial`. A session that lands there can prove a TOTP code, a recovery
 * code, or a passkey, and any of the three lifts it.
 *
 * 🔴 **The constraint that produced this paragraph has not gone away**, it has
 * only been satisfied once. Anything that registers a *new* kind of factor
 * inherits it whole: a row in one of these tables makes every later login open
 * `parcial`, and the way out has to exist in the same deploy.
 *
 * **So the ordering is a hard constraint, not a preference: the endpoint that
 * verifies a factor has to be live before, or in the same deploy as, the first
 * endpoint that registers one.** Shipping registration first locks out
 * whoever registers first — starting with whoever tests it.
 *
 * ⚠️ **And `onboarding` is the branch that fires on its own — read this one
 * before turning `MFA_OBLIGATORIO` on.** With it off, which is the default
 * since 9 October 2026, none of this paragraph happens: an account with no
 * factor is let in and no clock is started. With it on, `parcial` needs
 * somebody to register something first, and this one happens to
 * **everybody**, deterministically, `MFA_GRACE_DAYS` after each account's own
 * first login. No row has to be inserted and nobody has to
 * do anything: the clock this function starts runs out by itself.
 *
 * When it does, the login still answers 200 and the cookie is still set — and
 * then `authenticate` refuses everything outside the allowlist in
 * `sessionState.ts`. The extra doors `ONBOARDING_EXTRA` opens are the way out,
 * and every prefix on that list has a router mounted behind it in `app.ts`:
 * `/totp`, `/webauthn/register` and `/webauthn/credentials` among them, and
 * registering a TOTP or a passkey is what ends `onboarding`. The paragraph is
 * kept because the shape of the failure is worth remembering: an allowlist
 * entry for a route nobody mounted is a room with a door painted on it, and
 * for a while `/webauthn/credentials` was exactly that.
 *
 * **The manual reprieve, if a deadline has to be pushed back:**
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
  fuenteEnElLogin?: FuenteEnElLogin,
  /** Forwarded to both reads — see `tieneCredencialRegistrada` for the pool. */
  opciones: { transaction?: Transaction } = {},
): Promise<{
  estado: EstadoSesion;
  graceUntil: Date | null;
  conFactor: boolean;
  conCredencial: boolean;
}> {
  // The two questions, asked side by side rather than through
  // `tieneAlgunFactor`, because the caller needs both answers: `conFactor`
  // decides the branch, `conCredencial` is what the passwordless guard reads.
  const [conCredencial, correo] = await Promise.all([
    tieneCredencialRegistrada(usuario.id, opciones),
    correoVerificado(usuario.id, opciones),
  ]);
  if (conCredencial || correo) {
    // No deadline is stamped on them: they have nothing left to be given
    // fourteen days for, and a date in that column reads as "this account is
    // still being chased". True whichever of the two states below fires.
    if (fuenteEnElLogin) {
      return { estado: "completa", graceUntil: null, conFactor: true, conCredencial };
    }
    return { estado: "parcial", graceUntil: null, conFactor: true, conCredencial };
  }

  // From here down the account has no factor at all, and what happens to it is
  // the one thing `MFA_OBLIGATORIO` decides. Off — the default — it is simply
  // let in: no deadline is started, and one already in the column is not read,
  // so an account stamped while the switch was on is not chased after it goes
  // off. `graceUntil: null` is what makes that hold beyond this call: the
  // callers write the column only for a date, and `estadoEfectivo` narrows
  // nobody whose column is empty.
  if (!mfaObligatorio()) {
    return { estado: "completa", graceUntil: null, conFactor: false, conCredencial: false };
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
    return {
      estado: "completa",
      graceUntil: new Date(ahora.getTime() + MFA_GRACE_DAYS * DIA_MS),
      conFactor: false,
      conCredencial: false,
    };
  }

  // `<=` and not `<`: the stored instant is when the grace is over, so a login
  // at exactly that millisecond is already past it.
  return {
    estado: limite <= ahora.getTime() ? "onboarding" : "completa",
    graceUntil: null,
    conFactor: false,
    conCredencial: false,
  };
}
