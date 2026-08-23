// The old front door's two addresses.
//
// `POST /` no longer has a handler of its own: it is mounted on
// `auth.controller.ts`'s `login`, the very same function `POST /api/auth/login`
// runs. `GET /` is all that is left of this file's own controller.

import { Router } from "express";
import { login } from "../controllers/auth.controller.js";
import { comprobarToken } from "../controllers/login.controller.js";

const router = Router();

/**
 * `POST /api/login` — the old address, on the new handler.
 *
 * **Why it is one handler and not two.** Two doors with two handlers is what
 * this used to be, and the objection is not tidiness: a login is a pile of
 * decisions that look removable from outside — the uniform message, the
 * levelled timings, the lockout, the 503 — and the second copy is where one of
 * them goes missing. One implementation on two URLs has nothing to keep in
 * step. What the two addresses answer cannot diverge, because there is only one
 * thing answering.
 *
 * **Why the address was not simply removed.** Because a browser holding a
 * cached bundle still posts here, and the two failures are not comparable. If
 * this 404s, that person cannot log in at all and no interceptor can help them:
 * there is no session to expire and nothing on screen but a failed request.
 * With the address alive they log in, get a working cookie, and the only thing
 * their stale bundle loses is what Task 4 was always going to take from it. The
 * plan accepts that second risk and names it; the first one it never accepted,
 * and deleting a line here is not worth buying it.
 *
 * **When it can go.** `web` no longer calls it — `Login.api.ts` posts to
 * `/api/auth/login` — so the condition is the same measurement Task 1 makes for
 * the bearer token: count the requests reaching this route in the Coolify logs
 * (`httpLogger` writes a line per request) over a full working day after the
 * frontend that stopped calling it has shipped. Zero means nothing points here,
 * and then this line, its two entries in `routeGuards.test.ts` and the rest of
 * this file go together. Task 3 already opens both of those files to retire
 * `GET /` below, which is where that work belongs.
 */
router.post("/", login);

router.get("/", comprobarToken);

export default router;
