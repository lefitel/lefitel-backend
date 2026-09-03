// The passwordless door — plan 4C, phase 2. Mounted at
// `/api/auth/webauthn/passwordless` in `app.ts`, **behind `requireVerifiedOrigin`
// and nothing else**.
//
// 🔴 **No `authenticate`, by construction, and this router exists so that the
// absence is visible.** `webauthn.routes.ts` opens with the rule that every
// route in it carries `authenticate`; these two cannot, because they are how
// somebody with no credential gets one. A separate file rather than two
// exceptions in that one, so that "every route here authenticates" stays
// literally true there and "no route here does" is literally true here.
// `routeGuards.test.ts` names both on `AUTHENTICATION_NOT_APPLICABLE` with the
// reason, and its honesty check would go red the day one of them gained it.
//
// 🔴 **And not under `/api/auth/webauthn/login`.** `sessionState.ts` opens
// that prefix to `parcial`, and `webauthn.routes.ts` forbids siblings under it
// for that reason. These two consult no allowlist at all — a request with no
// session never reaches one — so the prefix is outside every list on purpose,
// and the reachability table in `routeGuards.test.ts` records that as
// `false/false` with the note that the answer is not what protects them.
//
// **What does protect them, in order:** `requireVerifiedOrigin` at the mount
// — both CSRF barriers with no cookie waiver, because this is the one door
// that sets a cookie and asks for nothing (`csrf.ts` has the two attacks);
// the two address buckets below, one per route, keyed on the only thing an
// anonymous request has; and, inside the handler, the per-account budget on
// what a refusal may write. `loginRateLimit` is deliberately **not** here: its
// account bucket keys on `req.body.user`, which this body does not carry, and
// would collapse into a second address bucket of ten for the whole building —
// while spending, on a passkey ceremony, a budget that exists to bound
// password guesses.

import { Router } from "express";
import {
  passwordlessOptionsLimiter,
  passwordlessVerifyLimiter,
} from "../middleware/loginLimiters.js";
import {
  passwordlessOptions,
  passwordlessVerify,
} from "../controllers/webauthnPasswordless.controller.js";

const router = Router();

/**
 * The challenge: counts every request, because every request writes a row.
 * The assertion: counts refusals only, because a login that worked is not a
 * failed attempt. See the two limiters for the numbers and their defence.
 */
router.post("/options", passwordlessOptionsLimiter, passwordlessOptions);
router.post("/verify", passwordlessVerifyLimiter, passwordlessVerify);

export default router;
