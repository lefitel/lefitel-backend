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
import { loginRateLimit } from "../middleware/loginLimiters.js";
import {
  endSession,
  login,
  logout,
  logoutAll,
  me,
  sessions,
} from "../controllers/auth.controller.js";

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
router.delete("/sessions/:id", authenticate, endSession);

export default router;
