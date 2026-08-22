// Opening a session and handing it to the browser, in one place.
//
// Two lines that always go together: a row in `sesiones` and the cookie that
// names it. Written out at each call site they can be got half right — a row
// created and no cookie set is a session nobody can use and nothing will ever
// clean up before the purge; a cookie set from a token that was never stored is
// a 401 on the very next request.
//
// Both doors call this: `POST /api/auth/login`, where it is the whole point,
// and `POST /api/login`, where it rides along beside the JWT so that everybody
// who logs in through the current frontend is migrated without noticing.

import type { Request, Response } from "express";
import { createSession } from "./sessionStore.js";
import { setSessionCookie } from "./sessionCookie.js";

/**
 * Open a session for this person and put it in the response as a cookie.
 *
 * Returns nothing, deliberately. The token exists for exactly as long as this
 * function runs and then only the browser has it — a return value would be an
 * invitation to put it in a response body, which is the one thing the cookie
 * was introduced to stop.
 *
 * `user_agent` and `ip` are read off the request here rather than passed in, so
 * the two callers cannot disagree about which header the session list shows.
 * `req.ip` respects `trust proxy` (set to one hop in `app.ts`), so it is the
 * client's address and not the Coolify proxy's.
 */
export async function issueSession(req: Request, res: Response, id_usuario: number): Promise<void> {
  const { token, expiresAt } = await createSession(id_usuario, {
    userAgent: req.headers["user-agent"],
    ip: req.ip,
  });
  setSessionCookie(res, token, expiresAt);
}
