// How much room somebody gets to be wrong.
//
// Three budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops a guess, and the pair stops one machine grinding one
// account. The arithmetic of the third is the part that goes wrong quietly —
// an escalation with no ceiling is a button for locking a colleague out.

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import {
  LOGIN_IP_LIMIT,
  LOGIN_ACCOUNT_IP_LIMIT,
  LOGIN_WINDOW_MS,
  LOCKOUT_AFTER_FAILURES,
  LOCKOUT_BASE_MINUTES,
  LOCKOUT_MAX_MINUTES,
} from "../config/security.js";

/**
 * The username a login attempt is about, folded to one case-insensitive
 * identity.
 *
 * This lower-cases on top of trimming, which is *more* normalisation than
 * `login.controller.ts`'s own lookup does — that one only trims. The extra
 * step is deliberate here: usernames are unique case-insensitively (there is
 * a unique index on `lower("user")`), so "Isaias" and "isaias" are the same
 * account and must share one budget, not two. Without it, capitalising a
 * guess would buy a second, fresh bucket for the same target.
 */
function usuarioDe(req: Request): string {
  const u = (req.body as { user?: unknown } | undefined)?.user;
  return typeof u === "string" ? u.trim().toLowerCase() : "";
}

/**
 * The key each bucket counts a request against.
 *
 * Named functions rather than arrows written inline in the options, because
 * inline they could not be tested and were not: the only tests this file had
 * covered the two pure functions at the bottom. Every part of these two strings
 * is load-bearing and every part could be removed without a single test
 * noticing — dropping `ipKeyGenerator` (which folds an IPv6 address into its
 * /56 block, without which one holder of a prefix walks through billions of
 * separate buckets), or dropping `usuarioDe` from the second one (which is what
 * makes it a per-account bucket instead of a second, smaller copy of the first).
 *
 * The prefixes are not what keeps the two apart: every `rateLimit()` call builds
 * a store of its own, so these keys never meet. They are there so that a key
 * read back out of a store says which bucket it belongs to, and so that the day
 * a shared store arrives — Redis, once there is more than one process — the two
 * do not silently merge into one.
 */
export function ipBucketKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

export function accountBucketKey(req: Request): string {
  return `ipu:${ipKeyGenerator(req.ip ?? "")}:${usuarioDe(req)}`;
}

/**
 * By address, counting failures only.
 *
 * The budget it replaces was ten per quarter hour counting successes as well,
 * which behind a NAT is ten for the whole office. It also keyed on the raw
 * address: `ipKeyGenerator` folds IPv6 into its /56 block, without which one
 * holder of a prefix walks through billions of distinct keys.
 *
 * A hundred is deliberately generous. This bucket exists to stop a flood; the
 * per-account bucket below is what stops a guess, and it is the one with teeth.
 */
export const loginIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_IP_LIMIT,
  skipSuccessfulRequests: true,
  keyGenerator: ipBucketKey,
  message: { message: "Demasiados intentos desde esta red. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * By address and account together, so one machine cannot grind one name even
 * while the address budget still has room.
 */
export const loginAccountIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_ACCOUNT_IP_LIMIT,
  skipSuccessfulRequests: true,
  keyGenerator: accountBucketKey,
  message: { message: "Demasiados intentos. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** The buckets a login request passes, in order: the flood first, the guess second. */
const loginBuckets: readonly RateLimitRequestHandler[] = [loginIpLimiter, loginAccountIpLimiter];

/**
 * The whole login gate as one middleware, POST only.
 *
 * This was an anonymous arrow written inline at the mount in `app.ts`, and
 * taking either bucket out of it, or taking the POST guard out, left all 460
 * tests in this project green. Here it has a name and a home next to the buckets
 * it runs, which is what let `loginLimiters.test.ts` put a request through the
 * real mount and then read each bucket's counter to see what it charged.
 *
 * The POST guard is not a detail. `GET /api/login` is `comprobarToken`, which
 * the client calls on every page load to find out whether its token is still
 * good — counting those would spend an entire office's failure budget on people
 * who are already logged in.
 */
export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();

  // Each bucket is ordinary Express middleware: it either answers 429 itself
  // and never calls on, or calls on. So the chain is a walk down the array
  // where each step's `next` is the following bucket, and the last one is the
  // caller's own `next`. An error from any of them short-circuits to `next(err)`
  // so the terminal handler in `app.ts` answers, rather than the rejection
  // being dropped.
  const run = (i: number) => {
    if (i === loginBuckets.length) return next();
    loginBuckets[i](req, res, (err?: unknown) => (err ? next(err) : run(i + 1)));
  };
  run(0);
}

/** Whether this account is resting right now. */
export function estaBloqueada(u: { failed_attempts?: number; locked_until?: Date | null }): boolean {
  if (!u.locked_until) return false;
  return new Date(u.locked_until).getTime() > Date.now();
}

/**
 * The account's state after one more failure.
 *
 * The wait doubles, and stops doubling at the ceiling. Without a ceiling, an
 * escalation reaches hours, and in a company where everybody knows everybody's
 * username that is a button for locking a colleague out of their day.
 */
export function siguienteBloqueo(fallosPrevios: number): {
  failed_attempts: number;
  locked_until: Date | null;
} {
  const fallos = fallosPrevios + 1;
  if (fallos < LOCKOUT_AFTER_FAILURES) {
    return { failed_attempts: fallos, locked_until: null };
  }
  const exceso = fallos - LOCKOUT_AFTER_FAILURES;
  const minutos = Math.min(LOCKOUT_BASE_MINUTES * 2 ** exceso, LOCKOUT_MAX_MINUTES);
  return { failed_attempts: fallos, locked_until: new Date(Date.now() + minutos * 60_000) };
}
