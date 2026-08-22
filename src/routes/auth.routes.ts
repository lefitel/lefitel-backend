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

router.get("/me", authenticate, me);
router.post("/logout", authenticate, logout);
router.post("/logout-all", authenticate, logoutAll);
router.get("/sessions", authenticate, sessions);
router.delete("/sessions/:id", authenticate, endSession);

export default router;
