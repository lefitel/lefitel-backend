// How much room somebody gets to be wrong.
//
// Four budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops one machine grinding one name, the lockout arithmetic at
// the bottom stops a guess spread across many addresses, and the confirmation
// bucket stops a caller who is already logged in from using "prove it is you"
// as a password oracle. The arithmetic of the third is the part that goes wrong
// quietly — an escalation with no ceiling is a button for locking a colleague
// out — and the fourth is the one whose absence would be invisible, since the
// endpoint it guards deliberately charges nothing to the lockout.

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
  PASSWORD_CONFIRM_LIMIT,
} from "../config/security.js";

/**
 * The username a login attempt is about, folded to one case-insensitive
 * identity.
 *
 * This lower-cases on top of trimming, which is *more* normalisation than
 * `verifyCredentials`'s own lookup does — that one only trims. The extra
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
 * The key for confirming your own password, and it is the account — not the
 * address.
 *
 * `POST /api/auth/confirm-password` runs behind `authenticate`, so who is
 * asking is already known and comes off `req.user` rather than out of the body:
 * there is no username here to capitalise differently and buy a second bucket
 * with. Keying by account and not by address is what makes the budget follow
 * the thing being guessed at — somebody working through a stolen session's
 * password from a dozen addresses meets one bucket, not a dozen.
 *
 * The fallback exists because a key generator that returns `undefined` would
 * put every caller in one bucket and lock the endpoint for everybody. It cannot
 * be reached through the mount in `auth.routes.ts` — `authenticate` answers 401
 * before this runs — so what it really guards is somebody mounting this limiter
 * somewhere it is not behind authentication, and it fails towards the
 * address-shaped budget rather than towards no budget at all. `ipKeyGenerator`
 * for the same reason as the two above: without it one holder of an IPv6 /56
 * walks through billions of separate buckets.
 */
export function passwordConfirmKey(req: Request): string {
  const id = req.user?.id;
  return typeof id === "number" ? `pc:${id}` : `pc:ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * The budget for re-typing your own password, and the only limit that endpoint
 * has.
 *
 * **No `skipSuccessfulRequests`, unlike both buckets above, and that is the
 * whole point of writing this as a third bucket instead of reusing one of
 * them.** `POST /api/auth/confirm-password` answers a wrong password with
 * **200** and `{ correcta: false }` — deliberately, so no client can mistake
 * "wrong password" for "server broken" by reading a status code — so a
 * refund rule based on the status would hand back exactly the attempts this
 * bucket exists to charge for. Every request counts here, right or wrong.
 *
 * What it costs: somebody who confirms correctly five times in a quarter of an
 * hour waits. Nobody renames themselves five times in a quarter of an hour, and
 * the answer they get says to wait rather than that their password is wrong.
 *
 * Why the endpoint needs a bucket of its own at all — rather than nothing, now
 * that a wrong answer there no longer touches `failed_attempts`: an
 * authenticated endpoint that compares an unlimited number of passwords is a
 * password oracle for whoever already stole a session. The lockout cannot be
 * the answer (it would let anybody shut their own account out of the ERP by
 * mistyping while renaming themselves) so this is.
 */
export const passwordConfirmLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: PASSWORD_CONFIRM_LIMIT,
  keyGenerator: passwordConfirmKey,
  message: { message: "Demasiados intentos. Espere unos minutos antes de volver a confirmar." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Whether an answer costs the caller anything.
 *
 * `express-rate-limit` calls this option `requestWasSuccessful`. With
 * `skipSuccessfulRequests` on, what it actually decides is which answers get
 * refunded from the bucket once the response has finished, so the honest name
 * for it here is the other one: whatever this returns true for is free.
 *
 * The library's default is `statusCode < 400`. This adds the 5xx range, and the
 * line it draws is the one that matters — a 4xx is the caller being wrong, a
 * 5xx is this server being wrong, and an outage here is nobody's failed
 * attempt.
 *
 * **What it fixes.** The login used to answer a session it could not open with
 * 200 and a JWT, which `skipSuccessfulRequests` refunded; it now answers 503 on
 * both of its addresses, since both are mounted on the same handler. That had
 * started charging, and a 500 from anything else in the handler still does. The
 * address bucket is keyed by `ipKeyGenerator(req.ip)`, which behind the
 * office's NAT is one key for everybody, so a database outage during the
 * morning login rush spent a shared budget of a hundred on people who did
 * nothing wrong — and the sentence they are shown, "inténtelo de nuevo en unos
 * minutos", is an invitation to spend more of it. Fifteen people retrying half
 * a dozen times each reach the hundred, and then nobody in the building can log
 * in until the quarter-hour window rolls over, with the database back and the
 * ERP perfectly healthy. A cascade whose own error message recruits users to
 * make it worse.
 *
 * **Why this does not buy anybody a free guess**, which is the tension worth
 * resolving out loud, because making a guess cost something is exactly what the
 * address bucket is for. Probing means learning whether a credential is valid,
 * and the only two answers that carry that are 400 (no) and 200 (yes) — and 200
 * has been free since this bucket was written, because a login that works was
 * never a failed attempt. Neither status added here can be had *in place of* a
 * guess:
 *
 * - A 503 is only reachable past `verifyCredentials`, which is to say only by
 *   somebody whose password was already right. It confirms a credential its
 *   caller already holds; it cannot find one.
 * - A 500 is anything else in the handler failing. When that is the credential
 *   check itself, the server has declined to decide and every caller gets the
 *   same answer whatever they sent, which is the definition of no oracle; when
 *   it is the permission matrix afterwards, the password was already right and
 *   the previous point applies.
 *
 * A wrong password is still a 400 and still costs one, including during the
 * outage that produces a 503 — the `usuarios` read working while the `sesiones`
 * write does not. And the budget with teeth against guessing is untouched:
 * the per-account lockout in `verifyCredentials` moves only on a wrong
 * password, and it lives in a database column rather than a fifteen-minute
 * window.
 *
 * **What it does cost**, plainly: while this server is broken, the login route
 * stops shedding load through these buckets. That is smaller than it sounds —
 * a login that works never charged either, so these buckets have never limited
 * traffic that was not failing — and the alternative is an outage that locks
 * the office out after the outage is over.
 *
 * By range rather than by listing 503 and 500. The next 5xx anybody puts on
 * this route — a 502 or 504 from whatever ends up in front of it — would
 * silently start charging again, and "somebody adds a case the enumeration does
 * not cover" is the shape of half of this file's history.
 */
export function costsNothing(_req: Request, res: Response): boolean {
  return res.statusCode < 400 || res.statusCode >= 500;
}

/**
 * By address, counting the caller's own failures only — see `costsNothing`.
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
  requestWasSuccessful: costsNothing,
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
  requestWasSuccessful: costsNothing,
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
 * The POST guard is not a detail, and its reason has changed rather than gone
 * away. It was written for `GET /api/login`, the JWT verifier the client called
 * on every page load: counting those spent an entire office's failure budget on
 * people who were already logged in. That address is retired, and what is behind
 * this mount for every other method now is Express's 404 — which is worse to
 * count, not better. A budget shared by a whole office behind one NAT address
 * could be emptied by anybody sending GETs to a URL that does not exist, and
 * nobody in the building could log in until the window expired.
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
