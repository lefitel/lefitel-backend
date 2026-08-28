// The session routes.
//
// `authenticate` is declared per route here rather than at the mount in
// `app.ts`, and that is the point: `POST /login` is the one route in the API
// that cannot have it — it is what produces a credential — so putting the
// middleware at the mount would mean either an exception carved out of it or a
// login nobody can reach. Written route by route, which routes are open is
// something you can see instead of something you have to work out.
//
// None of these asks for a permission from the matrix, and `routeGuards.test.ts`
// holds each one on its exception list with the reason next to it. They are all
// about the caller's own session: there is no role that may or may not log
// itself out.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireStepUp } from "../middleware/requireStepUp.js";
import { loginRateLimit, passwordConfirmLimiter } from "../middleware/loginLimiters.js";
import {
  emailSendLimiter,
  emailVerifyLimiter,
  passwordForgotRateLimit,
  passwordResetRateLimit,
} from "../middleware/recoveryLimiters.js";
import {
  endSession,
  login,
  logout,
  logoutAll,
  me,
  sessions,
} from "../controllers/auth.controller.js";
import { sendVerificationEmail, verifyEmail } from "../controllers/email.controller.js";
import { forgotPassword, resetPassword } from "../controllers/password.controller.js";

const router = Router();

/**
 * The same rate limiter the old login mount uses, and the same buckets.
 *
 * `loginRateLimit` closes over one pair of `rateLimit()` stores, so mounting it
 * twice does not create a second budget: an attacker who has spent the
 * per-account budget on `/api/login` finds it already spent here. Two doors
 * with one budget between them is the whole reason to reuse the middleware
 * instead of building a second one.
 *
 * It skips anything that is not a POST, so mounting it here rather than over
 * the whole router is not what makes the logout routes cheap — writing it on
 * this line is, and it keeps the login's budget from being spent by somebody
 * logging out.
 */
router.post("/login", loginRateLimit, login);

// `POST /confirm-password` used to sit here, and it is retired rather than
// merely unused — which is the harder of the two things to do and the reason
// this note stays.
//
// It answered "is this my password?" for a screen that wanted to be sure before
// it changed something, and it existed because that screen used to ask the
// question **by calling the login**. Replacing that was right. Asking *before*
// the operation was not: the rule that settled it is the one the rename and the
// password change both follow now — the credential that authorises an operation
// travels in the request that performs it, so there is nothing in between for a
// separate confirmation to protect. A `pass` in the body of the write is a gate;
// a "yes" collected a moment earlier is a promise the next request does not have
// to keep.
//
// The step-up the MFA design asks for reads the same way: see
// `docs/specs/2026-08-21-autenticacion-mfa-design.md` §step-up, where the first
// enrolment of a factor "exige reintroducir la contraseña" — i.e. `pass` on
// `POST /auth/totp/setup`, not a confirmation call before it. Everything else on
// that list is satisfied by `mfa_satisfied_at` and no password at all.
//
// What it cost while it was mounted: it was the only endpoint in the API that
// compared a password with **no operation behind it**, any authenticated session
// could reach it, and it drank from the same `pc:<id>` budget as the two doors
// people actually use. It also forced that budget to charge every request right
// or wrong, because it answered a wrong password with 200 — see
// `passwordConfirmLimiter`, which can now refund the legitimate work it was
// charging for.
//
// `verifyOwnPassword` in `auth/credentials.ts` is what stays: it has a real
// caller in `updateUserName`, and `auth/verifyOwnPassword.test.ts` holds it.

router.get("/me", authenticate, me);
router.post("/logout", authenticate, logout);
router.post("/logout-all", authenticate, logoutAll);
router.get("/sessions", authenticate, sessions);

/**
 * Closing one of your other sessions is the one thing on this router a stolen
 * cookie must not be enough for, and until now it was.
 *
 * The specification marks it «Step-up. Solo filas propias» (§5), and only the
 * second half was implemented: `revokeSessionOf` puts `id_usuario` in the same
 * `where` as the id, so nobody can close somebody else's row. That is what
 * stops a caller reaching *outside* their own account; it says nothing about
 * what a caller who is already inside one may do.
 *
 * An audit of this plan walked the rest end to end. From a session in
 * `onboarding` — one that answers 403 to users, roles and the permission
 * matrix — `GET /sessions` still listed the account's whole device inventory
 * (`user_agent`, `ip_address` and the three dates, for every live session),
 * and this route then closed them one call at a time: every id on that list
 * except the one making the request. The victim is logged out everywhere, the
 * stolen session survives, and the account's own way of noticing a second
 * device is what performed it.
 *
 * `requireStepUp()` with no options, so an `onboarding` session is refused
 * outright rather than falling to the password fallback. This is the route
 * that made that branch reachable at all: `ONBOARDING_EXTRA` in
 * `auth/sessionState.ts` opens `/api/auth/sessions`, so `authenticate` lets
 * that state get this far, and the recomputed `req.user.estado` — see the
 * field's own comment in `authenticate.ts` — is what the gate reads. Twelve of
 * the fourteen mounts live under `/api/usuario`, `/api/rol` and
 * `/api/permisos`, which no state below `completa` reaches at all; the
 * fourteenth is `/email/send` below, and it is the opposite case — a door
 * `onboarding` has to keep.
 *
 * No permission gate above it, unlike the other mounts: there is no role that
 * may or may not close its own sessions, which is why the route also sits in
 * `routeGuards.test.ts`'s `GATE_NOT_APPLICABLE`. Ownership is enforced in the
 * query, not by the matrix.
 *
 * **`GET /sessions` and `POST /logout-all` are left as they are, and neither
 * is an oversight of this task.** The specification lists neither behind
 * step-up: the listing is a read of your own rows, and `logout-all` closes
 * *this* session along with the rest, so it cannot be used to keep a stolen
 * one alive. What the audit showed is that the listing makes the attack above
 * *comfortable*, not that it is the attack — and gating a read the settings
 * screen opens on load would ask for a password to look at a list. That the
 * `parcial` and `onboarding` allowlists open both is a decision that lives in
 * `auth/sessionState.ts`, and moving it belongs with the plan that gives those
 * states a screen of their own.
 */
router.delete("/sessions/:id", authenticate, requireStepUp(), endSession);

/**
 * Registering and confirming your own address. Task 4 of
 * `2026-08-25-correo-verificado-y-recuperacion`; see
 * `src/controllers/email.controller.ts` for the two handlers.
 *
 * Both behind `authenticate` like the five above, and both belong in
 * `routeGuards.test.ts`'s `GATE_NOT_APPLICABLE` for the same reason the
 * session routes do — no role may or may not verify its own address — but
 * that file is not touched here; see `task-4-report.md`.
 *
 * Task 6's rate limiters sit after `authenticate` on both, not before: each
 * is keyed by account (`req.user.id`), which only exists once `authenticate`
 * has run. See `middleware/recoveryLimiters.ts` for why neither one refunds
 * a request based on the response — both routes below can answer 200 for
 * reasons that have nothing to do with who is asking.
 *
 * `passwordConfirmLimiter` on `/email/send` only, and mounted **before**
 * `emailSendLimiter` — Ronda de arreglo 2 of Task 4's report. The handler
 * now requires the caller's current password (an account-takeover fix, see
 * its own comment), reusing the exact same budget `usuario.routes.ts` mounts
 * on the rename and the password change: one account, one secret being
 * confirmed, one bucket. Mounted first so that somebody already out of
 * guesses on that shared budget gets refused here, before `emailSendLimiter`
 * would otherwise charge the account's own 5/hour quota — and the company's
 * shared 100/day one — for a request that never had the right password to
 * begin with.
 */
/**
 * `requireStepUp({ permiteOnboarding: true })` on `/email/send`, and the
 * option is the whole point of the line.
 *
 * **Why the gate at all, when the handler already demands the password.** It
 * does, and that is as strong as anything the other mounts accept today — but
 * only because nobody has a factor yet. The gate's second branch exists to
 * say "with a factor on the account, a password is not an acceptable answer";
 * once plan 4B registers one, every gated route starts refusing passwords and
 * this route, alone, would go on taking them — the route whose own comment
 * calls itself "the fix for a real account-takeover chain". The `pass` check
 * in `email.controller.ts` stays: it is what a caller sends today, and the
 * gate's third branch lets a request with no `stepup_password` through while
 * the account has nothing to prove, so nothing that works today stops working.
 *
 * **Why the option.** `ONBOARDING_EXTRA` opens `/api/auth/email` on purpose,
 * and the plain gate would close it: measured, mounting `requireStepUp()`
 * here turns `app.auth.test.ts`'s "leaves the doors that finish the setup open
 * to that same session" from 400 to 403. Verifying an address is the
 * prerequisite for registering a factor (§5: `/auth/totp/*` answers 409
 * without it), and registering a factor is the only way out of `onboarding` —
 * so the plain gate would seal in every account that reached its deadline.
 * The option lets that one state past the state check and nothing else; an
 * `onboarding` session on an account that *does* have a factor is still
 * refused, by the factor check below it.
 *
 * **Before `passwordConfirmLimiter`, deliberately.** Both draw on the same
 * `pc:<id>` budget. The gate reads it without spending and charges only a
 * password it has already confirmed wrong — and then refuses, so the limiter
 * never runs in that request. One wrong password therefore costs one of the
 * five, whichever of the two compared it; mounted the other way round, a
 * request carrying a wrong `stepup_password` would be charged twice for the
 * same guess. Both still sit ahead of `emailSendLimiter`, which is the order
 * the comment above is about and which this line does not disturb.
 */
router.post("/email/send", authenticate, requireStepUp({ permiteOnboarding: true }), passwordConfirmLimiter, emailSendLimiter, sendVerificationEmail);
router.post("/email/verify", authenticate, emailVerifyLimiter, verifyEmail);

/**
 * Getting back in when you cannot log in at all. Task 5 of
 * `2026-08-25-correo-verificado-y-recuperacion`; see
 * `src/controllers/password.controller.ts` for the two handlers.
 *
 * **No `authenticate` on either** — unlike every route above, deliberately:
 * these two are what a person reaches for *because* they have no session,
 * so gating them on one would make them unreachable by the people they
 * exist for. `routeGuards.test.ts`'s `AUTHENTICATION_NOT_APPLICABLE` and
 * `GATE_NOT_APPLICABLE` need an entry each for both routes — not added
 * here; that file already mixes Isaias's uncommitted work with this plan's,
 * and he owns adding the two lines. See `task-5-report.md`.
 *
 * Task 6's rate limiters, mounted before either handler. Neither route takes
 * `authenticate`, so both key primarily on IP (the one thing a caller cannot
 * get a fresh copy of on every request) rather than on account — see
 * `middleware/recoveryLimiters.ts` for the full budgets, address plus a daily
 * backstop on `/forgot`, address plus the token on `/reset`.
 * `/password/forgot`'s chain never refunds, same reasoning as `/email/send`
 * above; `/password/reset`'s does, since a bad token there is a real 400 and
 * a 5xx is genuinely this server's fault.
 */
router.post("/password/forgot", passwordForgotRateLimit, forgotPassword);
router.post("/password/reset", passwordResetRateLimit, resetPassword);

export default router;
