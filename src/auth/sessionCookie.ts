import type { Request, Response, CookieOptions } from "express";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "../config/security.js";

export { SESSION_COOKIE_NAME };

/**
 * The attributes, in one place, so setting and clearing cannot disagree.
 *
 * Deliberately no `domain`. www.osefi.net and api.osefi.net share a registrable
 * domain, so they are already same-site: a host-only cookie set by the API
 * travels on the frontend's XHR with SameSite=Lax perfectly well. Adding
 * `domain` would buy nothing and cost two things — any subdomain could shadow
 * the cookie with a longer `path` (httpOnly stops reading, not overwriting),
 * and the session would ride along on every request to the frontend's host,
 * including every image.
 */
function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  };
}

/** Hand the browser a session. */
export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, { ...cookieOptions(), expires: expiresAt });
}

/**
 * Take it back.
 *
 * Same attributes as when it was set: a browser only drops a cookie whose name
 * and attributes match, so clearing it with a different `path` leaves the old
 * one exactly where it was.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

/** The token the browser sent, if it sent one. */
export function readSessionCookie(req: Request): string | undefined {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
}
