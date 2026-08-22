/**
 * The security numbers, in one place.
 *
 * They were scattered: the bcrypt cost written literally in three files, the
 * login budget inside `app.ts`, the password rules nowhere because there were
 * none. Changing one of them meant finding all of them, and the day the cost
 * went from 8 to 12 two of the three sites were missed.
 */

import bcryptjs from "bcryptjs";
import { randomBytes } from "node:crypto";

/**
 * bcrypt work factor. Was 8, which is roughly 25 ms — fast enough that a leaked
 * table is worth attacking offline. 12 is about 250 ms: imperceptible to a
 * person logging in, expensive enough to be worth it.
 */
export const BCRYPT_COST = 12;

/**
 * The cost a bcrypt hash was actually made with, read back out of its own
 * prefix (`$2a$12$...`), or `null` if the string does not look like a
 * bcrypt hash at all.
 *
 * This exists so a login can decide whether to re-hash by comparing against
 * `BCRYPT_COST` — a number — rather than testing the hash *string* against a
 * literal like `$2a$08$`. A literal only ever knows about one specific old
 * value: it caught cost 8 today, but a hash sitting at 10 or 11 would never
 * match it, and it would silently stop catching anything the next time
 * `BCRYPT_COST` itself moves (say, 12 to 14 — cost 12 and 13 would then be
 * "old" too, and a fixed prefix check has no way to know that). Deriving the
 * cost and comparing it to the constant stays correct no matter how many
 * times the constant changes.
 */
export function bcryptCostOf(hash: string): number | null {
  const match = /^\$2[aby]\$(\d\d)\$/.exec(hash);
  return match ? Number(match[1]) : null;
}

/** Twelve characters, and none of the common ones. No symbol requirement: the
 * NIST guidance has advised against composition rules since 2017, because they
 * produce `Password1!` and a note stuck to the monitor. */
export const PASSWORD_MIN_LENGTH = 12;

/** Five failures and the account rests. The wait grows, with a ceiling in
 * minutes rather than hours: a long lockout is a button anyone can press
 * against a colleague whose username they know. */
export const LOCKOUT_AFTER_FAILURES = 5;
export const LOCKOUT_BASE_MINUTES = 1;
export const LOCKOUT_MAX_MINUTES = 15;

/** Login budget per IP address, counting failures only.
 *
 * The old budget was 10 per quarter hour counting successes too, keyed on the
 * address. Behind a NAT that is the whole office sharing ten attempts — and
 * with the enrolment flow of the later plans, where one person makes five or
 * six POSTs, two people would exhaust it. */
export const LOGIN_IP_LIMIT = 100;
export const LOGIN_ACCOUNT_IP_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long a browser must refuse to reach this host over plain HTTP, in
 * seconds. Two years, which is what the preload list asks for.
 *
 * Here rather than written into the `helmet` call so that `app.security.test.ts`
 * can assert the header a browser actually receives without repeating the
 * digits. What that assertion catches is the wiring, not the number: `hsts:
 * { maxAge: ... }` misspelled, or the whole option lost in a helmet upgrade,
 * silently falls back to helmet's own default and nothing on the server reports
 * anything.
 */
export const HSTS_MAX_AGE_SECONDS = 63072000;

/** Variables the process refuses to start without, by environment. */
export function requiredEnv(nodeEnv: string | undefined): string[] {
  const always = ["JWT_SECRET"];
  // COOKIE_NAME must be `__Host-osefi_session` in production. A deployment
  // that forgets it does not fail — it boots with a cookie missing the
  // `__Host-` prefix's guarantee, shadowable from any subdomain, and nothing
  // would report it.
  return nodeEnv === "production" ? [...always, "CORS_ORIGIN", "COOKIE_NAME", "COOKIE_SECURE"] : always;
}

/**
 * One answer for every way of failing to log in.
 *
 * "Usuario inexistente" and "Contraseña incorrecta" are a directory of who
 * works here, answered to anyone who asks. So is a distinct message for a
 * locked account.
 */
export const CREDENCIALES_INVALIDAS = "Usuario o contraseña incorrectos.";

/**
 * A real hash of a value nobody knows, to compare against when the account
 * does not exist or is locked.
 *
 * Equal messages are not enough: without this, the failing paths that never
 * reach bcrypt answer in a millisecond while a wrong password takes two
 * hundred and fifty, and the difference is a two-order-of-magnitude oracle.
 *
 * This is a memoized async function over `bcryptjs.hash`, not a module-level
 * constant computed with `hashSync`, for two reasons. First, a module-level
 * `hashSync` call pays one bcrypt round (~250ms) every time this file is
 * imported, and it is imported from `src/index.ts`, so that cost would leak
 * into every test suite that pulls in the app. Second, `bcryptjs` in
 * `login.controller.test.ts` is mocked with only `compare` and `hash` — no
 * `hashSync` — so a module-level `hashSync` call would throw at import time
 * there.
 *
 * The cache holds the *promise*, not the resolved string: caching the string
 * would let several concurrent unknown-user logins all read the cache as
 * empty before the first `bcryptjs.hash` finishes, and each start its own
 * 250ms hash in parallel — one wasted round per request in the burst instead
 * of one per process. Caching the promise means every call after the first
 * one awaits that same in-flight hash. A rejection is not cached: the promise
 * is cleared before it is rethrown, so a failed attempt does not wedge every
 * later call behind a dead promise forever.
 *
 * `src/index.ts` calls this once at boot, unawaited, to warm the cache before
 * the first request can reach it — see the comment there for why that matters
 * on top of memoization alone.
 */
let fillerHashPromise: Promise<string> | null = null;
export function fillerHash(): Promise<string> {
  if (!fillerHashPromise) {
    fillerHashPromise = bcryptjs.hash(randomBytes(32).toString("hex"), BCRYPT_COST).catch((err) => {
      fillerHashPromise = null;
      throw err;
    });
  }
  return fillerHashPromise;
}

/**
 * How long a session lives.
 *
 * Seven days of not being used and it is gone; every request pushes that back
 * another seven. With an absolute ceiling of thirty days from creation, however
 * much it is used — which is the thing the old JWT did not have, and why a
 * stolen token could live forever by being used.
 */
export const SESSION_IDLE_DAYS = 7;
export const SESSION_ABSOLUTE_DAYS = 30;

/**
 * How stale `last_used_at` is allowed to get before it is worth a write.
 *
 * Writing it on every request turns every read into a write: one report export
 * makes around two thousand sequential requests, which would be two thousand
 * UPDATEs and two thousand dead tuples on one row.
 */
export const SESSION_TOUCH_THROTTLE_MINUTES = 5;

/**
 * Widths of `sesiones.user_agent` and `sesiones.ip_address`.
 *
 * These already exist twice — as literal column widths in `sesion.model.ts`
 * and again in the migration that created them — so the session store reads
 * the number from here instead of holding a third silent copy in a `.slice`
 * call, the kind of copy that keeps truncating at the old width the day the
 * column actually grows.
 */
export const SESSION_USER_AGENT_MAX = 255;
export const SESSION_IP_MAX = 45;

/**
 * The session cookie's name, and whether it must be Secure.
 *
 * In production the name carries the `__Host-` prefix, which a browser only
 * accepts on a cookie that has no `domain`, has `path=/`, and is `Secure`.
 * That makes the cookie impossible to shadow from a subdomain by construction
 * rather than by our own care.
 *
 * In development the prefix cannot be used, because `Secure` rules out
 * `http://localhost`. Hence a variable rather than a constant.
 */
export const SESSION_COOKIE_NAME = process.env.COOKIE_NAME ?? "osefi_session";
export const SESSION_COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
