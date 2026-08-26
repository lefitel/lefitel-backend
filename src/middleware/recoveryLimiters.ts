// How much room somebody gets to be wrong on the four routes that get an
// account back into use: asking for a reset link, redeeming one, asking for a
// verification link, and redeeming that. Sibling of `loginLimiters.ts`, split
// out rather than added to it because these four answer to a different shape
// of attacker than the login does — nobody is guessing a password here, they
// are either flooding a mail quota that is shared with the rest of the
// company, or burning CPU against a route that asks for no credential at all.
//
// Two of these routes are deliberately mute — `/password/forgot` and
// `/email/send` answer the exact same 200, whatever actually happened, per
// Global Constraint #1 — and that mutes the one tool `loginLimiters.ts`
// built for this: `costsNothing` / `confirmCostsNothing` decide whether to
// refund a request by reading `res.statusCode`, and on a mute route that
// status is 200 for a legitimate sender *and* for whoever is probing it.
// Wiring either refund rule onto a mute route does not fail loudly — it
// passes every shape test and refunds every request, successful or hostile
// alike, which is a bucket that only ever reads zero. So neither
// `passwordForgot*Limiter` nor `emailSendLimiter` below sets
// `requestWasSuccessful` at all: they charge every request that reaches them,
// whatever it answers, on purpose. `recoveryLimiters.test.ts` demonstrates
// this by adding the refund back in and watching the exhaustion test that
// depends on its absence go red.
//
// `/password/reset` and `/email/verify` are not mute — a bad token really is
// a 400, a good one really is a 200 — so both of them do reuse
// `loginLimiters.ts`'s `costsNothing`: charge the 4xx that means "that guess
// was wrong", refund the 2xx that means "it worked" and the 5xx that means
// "this server broke", for the same reason the login buckets do.

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { hashOpaqueToken } from "../auth/opaqueToken.js";
import { costsNothing } from "./loginLimiters.js";
import {
  RECOVERY_WINDOW_MS,
  PASSWORD_FORGOT_EMAIL_LIMIT,
  PASSWORD_FORGOT_IP_LIMIT,
  EMAIL_SEND_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
  PASSWORD_RESET_TOKEN_LIMIT,
  EMAIL_VERIFY_LIMIT,
} from "../config/security.js";

/**
 * The address `/password/forgot` was asked about, folded to one identity.
 *
 * Trim and lower-case, same normalisation `password.controller.ts`'s own
 * `normalizedEmailFrom` applies — but computed independently rather than
 * imported from there: this key has to exist even for a body the controller
 * would refuse outright (no `email` field, the wrong type, a shape that fails
 * the regex), because the mute route charges those requests too. There is
 * nothing here checking the result is a *valid-looking* address on purpose:
 * a bucket keyed on the raw string still bounds how many times one exact
 * string can be sent, which is all this key is for.
 */
function forgotEmailKey(req: Request): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return `pf-email:${typeof email === "string" ? email.trim().toLowerCase() : ""}`;
}

/** By address. Prefixed like every key in `loginLimiters.ts` is, for the same
 *  reason: each `rateLimit()` call owns its own store, so the prefix is not
 *  what keeps this apart from the login's own IP bucket — it is what a key
 *  read back out of a shared store, the day one arrives, would need to tell
 *  the two apart. */
function forgotIpKey(req: Request): string {
  return `pf-ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/** By account — `/email/send` runs behind `authenticate`, so there is a
 *  session and no address to key on the way `/password/forgot` does. The
 *  fallback is unreachable through the real mount for the same reason
 *  `passwordConfirmKey`'s is in `loginLimiters.ts`: `authenticate` answers 401
 *  before this runs. What it guards is the same thing — this limiter mounted
 *  somewhere without authentication in front of it — and it fails towards an
 *  address-shaped budget rather than towards one shared by the whole world. */
function emailSendKey(req: Request): string {
  const id = req.user?.id;
  return typeof id === "number" ? `es:${id}` : `es:ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/** By account, same reasoning as `emailSendKey` — a distinct prefix so the
 *  two never share a bucket even if a shared store arrives later, which
 *  matters here specifically: `/email/send` and `/email/verify` are two
 *  different budgets for two different things, not one budget split across
 *  two doors the way the login's account bucket is deliberately shared. */
function emailVerifyKey(req: Request): string {
  const id = req.user?.id;
  return typeof id === "number" ? `ev:${id}` : `ev:ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/** By IP — `/password/reset`'s primary key. See `PASSWORD_RESET_IP_LIMIT`'s
 *  own comment in `config/security.ts` for why the token cannot be this. */
function resetIpKey(req: Request): string {
  return `pr-ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * By the token being redeemed — `/password/reset`'s secondary key.
 *
 * Hashed with the same `hashOpaqueToken` the real redemption in
 * `tokenStore.ts` uses, rather than the raw value: the raw token never needs
 * to exist as a map key sitting in this process's memory when a hash serves
 * exactly as well for equality, and Global Constraint #2's discipline about
 * where a token is allowed to appear in plain form is cheap to extend one
 * step further than the letter of it requires.
 *
 * The fallback for a missing or non-string token is address-shaped, same
 * reasoning as `passwordConfirmKey` in `loginLimiters.ts`: this route takes
 * no `authenticate`, so — unlike that one — the fallback *is* reachable, by
 * anybody who posts a body with no `token` field at all. Falling back to one
 * shared key for every such caller would let a single crafted body lock the
 * bucket for the entire internet; falling back to the address is what keeps
 * it a per-caller budget instead.
 */
function resetTokenKey(req: Request): string {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof token === "string" && token.length > 0) {
    return `pr-token:${hashOpaqueToken(token)}`;
  }
  return `pr-token:ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * The mute half of `/password/forgot`'s budget: by address.
 *
 * No `requestWasSuccessful` — see the module comment above for why setting
 * one here is the mistake this file exists to not make. Every request that
 * reaches this bucket counts, 200 or 400 alike.
 */
export const passwordForgotEmailLimiter = rateLimit({
  windowMs: RECOVERY_WINDOW_MS,
  limit: PASSWORD_FORGOT_EMAIL_LIMIT,
  keyGenerator: forgotEmailKey,
  message: { message: "Demasiadas solicitudes para esta dirección. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** The mute half of `/password/forgot`'s budget: by address, the caller
 *  cannot rotate. Same absence of `requestWasSuccessful`, same reason. */
export const passwordForgotIpLimiter = rateLimit({
  windowMs: RECOVERY_WINDOW_MS,
  limit: PASSWORD_FORGOT_IP_LIMIT,
  keyGenerator: forgotIpKey,
  message: { message: "Demasiadas solicitudes desde esta red. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});


/**
 * All three `/password/forgot` buckets as one middleware.
 *
 * Address first, then the address-that-cannot-be-rotated, then the daily
 * backstop — cheapest and most specific first, so a single attacker hammering
 * one address or one network is turned away by its own bucket well before the
 * shared daily one ever has to notice them. The daily bucket only sees
 * traffic that already cleared the other two, which is exactly the case it
 * exists for: many addresses, many networks, each individually under budget,
 * summing past the mail quota.
 *
 * Same recursive-`next` shape as `loginRateLimit` in `loginLimiters.ts`, and
 * for the same reason: each bucket is ordinary middleware that either answers
 * 429 itself or calls on, so an error from any of them reaches `next(err)`
 * instead of being dropped.
 */
/**
 * 🔴 `passwordForgotDailyLimiter` used to be the third entry here, and it is
 * gone on purpose. Middleware runs before the handler, so it could only count
 * *requests*, and requests are not the resource: fifty POSTs carrying a
 * malformed body answered 400, sent no mail, spent none of Resend's quota, and
 * still shut recovery off for the whole company for twenty-four hours —
 * `RateLimit-Remaining` counting down for whoever was doing it. A defence
 * cheaper to defeat than the thing it defends is worse than none, because it
 * is also a denial of service somebody else can trigger.
 *
 * The ceiling it was reaching for now lives at the send site,
 * `auth/mailBudget.ts`, where the thing being counted is the thing being
 * spent. The two buckets left here are the ones whose keys are honest: an
 * address and a network.
 */
const forgotBuckets: readonly RateLimitRequestHandler[] = [
  passwordForgotIpLimiter,
  passwordForgotEmailLimiter,
];

/**
 * How many buckets `/password/forgot` actually runs behind, exported so a test
 * can assert it. There were three; the third counted requests instead of mail
 * and is documented above as an absence rather than deleted quietly, because
 * re-adding it looks like an improvement to anybody who has not read why it
 * went.
 */
export const FORGOT_BUCKET_COUNT = forgotBuckets.length;

export function passwordForgotRateLimit(req: Request, res: Response, next: NextFunction) {
  const run = (i: number) => {
    if (i === forgotBuckets.length) return next();
    forgotBuckets[i](req, res, (err?: unknown) => (err ? next(err) : run(i + 1)));
  };
  run(0);
}

/**
 * `/email/send`'s only budget: by account.
 *
 * No `requestWasSuccessful`, same reasoning as the `/password/forgot`
 * buckets above — this route answers the same 200 whether the address just
 * got registered, replaced somebody else's still-unverified claim on it, or
 * Resend itself is down, so a refund rule reading `res.statusCode` would
 * refund the legitimate sends and the hostile ones alike.
 */
export const emailSendLimiter = rateLimit({
  windowMs: RECOVERY_WINDOW_MS,
  limit: EMAIL_SEND_LIMIT,
  keyGenerator: emailSendKey,
  message: { message: "Demasiadas solicitudes. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * `/password/reset`'s primary budget: by address.
 *
 * Reuses `costsNothing` from `loginLimiters.ts` rather than a copy: this
 * route is not mute, a bad token is genuinely a 400 and a good one genuinely
 * a 200, so the same rule the login buckets use — charge a 4xx, refund a 2xx
 * or a 5xx — is exactly right here too, for the reason `password.controller.ts`
 * gives by name: a 5xx is this server breaking, not a failed attempt, and
 * refunding it is what keeps a database blink from locking a shared bucket
 * for a quarter of an hour the way it once did on the login.
 */
export const passwordResetIpLimiter = rateLimit({
  windowMs: RECOVERY_WINDOW_MS,
  limit: PASSWORD_RESET_IP_LIMIT,
  skipSuccessfulRequests: true,
  requestWasSuccessful: costsNothing,
  keyGenerator: resetIpKey,
  message: { message: "Demasiadas solicitudes desde esta red. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** `/password/reset`'s secondary budget: by token. Same refund rule as the
 *  address bucket above, and the same reasoning. */
export const passwordResetTokenLimiter = rateLimit({
  windowMs: RECOVERY_WINDOW_MS,
  limit: PASSWORD_RESET_TOKEN_LIMIT,
  skipSuccessfulRequests: true,
  requestWasSuccessful: costsNothing,
  keyGenerator: resetTokenKey,
  message: { message: "Demasiados intentos con este enlace. Solicite uno nuevo si sigue fallando." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Both `/password/reset` buckets as one middleware, address first.
 *
 * The order is not a detail: the address bucket is the one a guesser cannot
 * dodge by inventing a fresh token on every request, so it has to be the one
 * that actually sees every request, including the ones whose token bucket
 * would otherwise still have room. Reversing the order would let a caller who
 * never reuses a token skip the address bucket's count entirely for the
 * request that finally gets it right — see `PASSWORD_RESET_IP_LIMIT`'s
 * comment in `config/security.ts` for why a token-keyed bucket alone is not a
 * limiter at all against that caller.
 */
const resetBuckets: readonly RateLimitRequestHandler[] = [passwordResetIpLimiter, passwordResetTokenLimiter];

export function passwordResetRateLimit(req: Request, res: Response, next: NextFunction) {
  const run = (i: number) => {
    if (i === resetBuckets.length) return next();
    resetBuckets[i](req, res, (err?: unknown) => (err ? next(err) : run(i + 1)));
  };
  run(0);
}

/**
 * `/email/verify`'s only budget: by account.
 *
 * Reuses `costsNothing`, same as the reset buckets above and for the same
 * reason: this route is not mute either — `TOKEN_INVALIDO` is a real 400 that
 * means the guess was wrong, `EMAIL_VERIFICADO_MENSAJE` is a real 200 that
 * means it was not a guess at all, whoever produced it already held the
 * token.
 */
export const emailVerifyLimiter = rateLimit({
  windowMs: RECOVERY_WINDOW_MS,
  limit: EMAIL_VERIFY_LIMIT,
  skipSuccessfulRequests: true,
  requestWasSuccessful: costsNothing,
  keyGenerator: emailVerifyKey,
  message: { message: "Demasiados intentos. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});
