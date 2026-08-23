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
  // COOKIE_NAME should be `__Host-osefi_session` in production. This only
  // proves it was *set* — a deployment that sets it to something without
  // the `__Host-` prefix still boots, and this list has no way to catch
  // that. `index.ts` runs the value check separately, at boot, with
  // `cookieNameCarriesHostPrefix`.
  return nodeEnv === "production" ? [...always, "CORS_ORIGIN", "COOKIE_NAME", "COOKIE_SECURE"] : always;
}

/**
 * The origin the frontend runs on in development, and the only origin this
 * process ever assumes instead of being told.
 *
 * Reaching it in production used to be described here as impossible because
 * `requiredEnv` puts CORS_ORIGIN on the production list and `index.ts` exits
 * before the server ever listens if it is missing. That guarantee only fires
 * when `process.env.NODE_ENV` reads exactly `"production"` — and NODE_ENV
 * itself can never be added to `requiredEnv`'s list, because it is the value
 * that *selects* the list. A deployment path that never sets it at all (a
 * platform's auto-detected buildpack instead of this repo's Dockerfile, a
 * start command that overrides `CMD`, `node dist/index.js` run by hand) skips
 * `requiredEnv`'s production branch entirely: the process boots believing it
 * needs only `JWT_SECRET`, and this constant is exactly what `allowedOrigins`
 * used to fall back to — with `credentials: true` already applied to it, in
 * whatever unknown environment happened to be running. See `allowedOrigins`
 * for the fix, which no longer trusts "not literally production" to mean
 * "safe to guess development".
 */
export const DEV_FRONTEND_ORIGIN = "http://localhost:5173";

/**
 * The origins allowed to send a credentialed request, and the only ones.
 *
 * Read once in `app.ts` and handed to both `cors()` and the CSRF guard, because
 * two copies of a list are two copies that can drift — and the drift nobody
 * notices is the one where the guard's copy is the wider of the two.
 *
 * Comma-separated, so a second frontend (a preview deployment) is a variable
 * and not a code change.
 *
 * Two normalisations, and the asymmetry with the `Origin` header is the point of
 * them. This list is typed by a person into a deployment panel, so surrounding
 * whitespace and one trailing slash are forgiven: `CORS_ORIGIN=https://www.osefi.net/`
 * otherwise matches nothing whatsoever, because an `Origin` header never carries
 * a path — and that failure is total and silent, every browser request blocked
 * while the server logs clean 200s. The header itself is written by the browser
 * and is compared byte for byte; normalising *that* would be inventing latitude
 * for somebody else to use.
 *
 * `*` is dropped rather than passed through. A wildcard cannot coexist with
 * credentials — every browser refuses `Access-Control-Allow-Origin: *` next to
 * `Access-Control-Allow-Credentials: true` — so a deployment that writes one is
 * asking for something no browser will honour. Dropping it leaves an empty list,
 * which refuses everything loudly, instead of a header that is quietly ignored.
 * It is also why `app.ts` hands the result to `cors()` as an array: given the
 * bare string `"*"` that middleware emits the forbidden wildcard, given `["*"]`
 * it emits no `Access-Control-Allow-Origin` at all.
 *
 * A blank CORS_ORIGIN counts as unset, which is the same test `requiredEnv`
 * applies — otherwise the two disagree about what "missing" means.
 *
 * **The second argument, and why an unset CORS_ORIGIN no longer means
 * development.** It used to: `allowedOrigins(raw)` fell back to
 * `DEV_FRONTEND_ORIGIN` for any `raw` that was missing or blank, regardless of
 * environment, on the theory that `requiredEnv` would already have stopped a
 * production process that reached here without CORS_ORIGIN set. That theory
 * is true only for a process whose `NODE_ENV` is the exact string
 * `"production"` — and a deployment that leaves `NODE_ENV` completely unset
 * (see `DEV_FRONTEND_ORIGIN`'s comment) is not caught by that check either,
 * because `nodeEnv === "production"` is false for `undefined` too. So the old
 * code asked the wrong question — "is this *not* production?" — which every
 * unset, misspelled, or merely-unfamiliar environment name answers "yes" to.
 * The fix asks the opposite question, "is this *known* to be development?",
 * and answers everything else — `"production"`, `"staging"`, a typo, or
 * nothing at all — by refusing every credentialed origin. An empty list fails
 * closed and loudly: `cors()` and the CSRF guard both refuse everything, which
 * is a visible outage, not a silent hole answering production traffic with
 * `Access-Control-Allow-Credentials: true` for `http://localhost:5173`.
 */
export function allowedOrigins(raw: string | undefined, nodeEnv: string | undefined): string[] {
  const configured = raw !== undefined && raw.trim() !== "";
  if (!configured) {
    return nodeEnv === "development" ? [DEV_FRONTEND_ORIGIN] : [];
  }
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin !== "" && origin !== "*");
}

/**
 * The header a cookie-authenticated write has to carry, lower-cased because
 * that is how Node presents `req.headers`.
 *
 * What protects anything here is neither the name nor the value: it is that the
 * header is not one of the four CORS-safelisted request headers, so a browser
 * refuses to send it cross-site without asking permission first, and the only
 * origins this API grants that permission to are `allowedOrigins`. A form posted
 * from evil.osefi.net *can* carry the session cookie — a subdomain is same-site,
 * so `SameSite=Lax` does not stop it — and it cannot carry this.
 *
 * The value is therefore never checked, only its presence, and that is a
 * decision rather than an omission. Any value ships inside a JavaScript bundle
 * that anybody can read, so it cannot be a secret; pinning a particular string
 * would only invite somebody to "rotate" it later and refuse every browser still
 * holding the previous bundle, for nothing gained. It also means the two
 * repositories share a header *name* and no value: the name is a wire format and
 * has to match, and there is no constant to keep in step across two deployments.
 */
export const CSRF_CLIENT_HEADER = "x-osefi-client";

/**
 * The header that carries the caller's current role, on every authenticated
 * response, cookie or old bearer token alike.
 *
 * `authenticate` already reads the role from the database on every request —
 * it has to, to notice a demotion or an archived account — so putting it on
 * a response header costs no query of its own; it is the same read the
 * request already paid for, handed back instead of kept to itself.
 *
 * This is what replaces the `x-new-token` mechanism `app.ts` still has a
 * comment about: the server used to re-sign a JWT on every request so the
 * frontend could decode its `id_rol` and notice a role change. That re-signing
 * is gone, so there is no token left to decode a role out of. A bare role id
 * is a smaller thing to get wrong than a signed token, and it is honest about
 * what it is for — noticing a change, not carrying a credential — whereas a
 * JWT sitting in a header nobody reads for its expiry is a credential doing
 * nothing, which is exactly what `x-new-token` had become.
 *
 * Like `CSRF_CLIENT_HEADER`, this is a response detail and not a secret, so
 * there is nothing wrong with a script on the page reading it — the browser
 * only needs the name in `app.ts`'s `exposedHeaders` to be allowed to.
 */
export const ROLE_HEADER = "x-osefi-role";

/**
 * The header that carries the moment this session really stops working, on
 * every response `authenticate` let through on a session cookie.
 *
 * **Format: ISO 8601 in UTC**, i.e. what `Date.prototype.toISOString()`
 * produces — `2026-09-01T00:00:00.000Z`. That is the shape `GET /api/auth/me`
 * already puts in its body, because JSON serialises a `Date` this way, and
 * that is the whole reason for the choice over epoch milliseconds: the
 * frontend already parses one of these with `new Date(...)`, so one format
 * means one parser on that side and no way for the header and the body to
 * disagree about what a bare number meant. It also reads as a date in a `curl`
 * transcript, which a millisecond count does not.
 *
 * **Why a header and not just the body of `/auth/me`.** The server slides a
 * session on *any* authenticated request, and `authenticate` is middleware, so
 * this is set before a controller runs and rides on every authenticated
 * response — the 422 of a failed validation included. A client that learns the
 * expiry only from bodies it can parse, or only from 2xx answers, counts down
 * to a deadline the server has already moved: it warns and logs somebody out
 * with the session perfectly alive, which is the failure this is here to stop.
 *
 * **Absent means "nothing to say", never "it expires now".** A request that
 * arrived on the old bearer token has no session row and therefore no expiry
 * to report — the same case `/auth/me` answers with `expires_at: null` — and a
 * proxy that drops headers it does not recognise produces the same absence.
 * So a reader keeps whatever deadline it already had when this is missing, and
 * reschedules only on a value it actually received.
 *
 * Like `ROLE_HEADER`, this is a response detail and not a secret, and the name
 * has to be in `app.ts`'s `exposedHeaders` for a browser to let the page's own
 * JavaScript read it at all.
 */
export const SESSION_EXPIRES_HEADER = "x-osefi-session-expires";

/**
 * What a write refused by the origin check is told.
 *
 * The same sentence for both halves of the check, deliberately. For a real
 * person the realistic causes are a stale bundle and a proxy that strips headers
 * it does not recognise, and "reload the page" is the answer to both — for the
 * header half literally: `middleware/csrf.ts`'s `refuse()` clears the session
 * cookie on that refusal, so a stale one no longer answers the reload with the
 * same failure. Which half failed goes to the log, where it is useful, and not
 * into the response, where it would only help somebody probing.
 */
export const PETICION_NO_VERIFICABLE =
  "No se pudo verificar el origen de la petición. Recargue la página e inténtelo de nuevo.";

/**
 * One answer for every way of failing to log in.
 *
 * "Usuario inexistente" and "Contraseña incorrecta" are a directory of who
 * works here, answered to anyone who asks. So is a distinct message for a
 * locked account.
 */
export const CREDENCIALES_INVALIDAS = "Usuario o contraseña incorrectos.";

/**
 * The other thing a login can answer, and the only other one.
 *
 * Here beside `CREDENCIALES_INVALIDAS` rather than in `auth/credentials.ts`,
 * where it started. Two login messages living in two files is how one of them
 * gets reworded by somebody who never sees the other, and the whole point of
 * the pair is the line between them: this one is about the *request* — a field
 * missing or not a string — and it gives nothing away about who has an account
 * here, so it may be specific. Anything that depends on the account itself says
 * `CREDENCIALES_INVALIDAS` and takes the same time doing it.
 */
export const CREDENCIALES_INCOMPLETAS = "Usuario y contraseña son obligatorios.";

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
 * How often `purgeExpiredSessions` runs once the process has booted.
 *
 * Daily is fine-grained enough: expiry is measured in days, so a row sits
 * around at most one extra day past the moment it stopped mattering — nothing
 * a browser or an audit would ever notice — and coarse enough that the purge
 * is not competing with real traffic for the connection pool every few
 * minutes.
 */
export const SESSION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

/**
 * Whether `name` can actually deliver the guarantee a `Secure` session
 * cookie relies on.
 *
 * `requiredEnv` only checks that `COOKIE_NAME` was *set* — it has no opinion
 * on what it says. A deployment that types `__host-osefi_session` (lower
 * case), `_Host-osefi_session` (one underscore), or the bare name with no
 * prefix at all boots clean and logs in fine: nothing about that failure is
 * visible until a hostile subdomain shadows the cookie, because a browser
 * reads `__Host-` byte for byte and grants its protection to nothing less.
 * This is the check that has to run at boot, before that deployment ever
 * takes traffic.
 *
 * Only meaningful when the cookie is `Secure`: `__Host-` itself requires
 * `Secure`, so an insecure cookie — development's plain name over
 * `http://localhost` — could never carry the prefix regardless, and is not
 * a violation of anything.
 */
export function cookieNameCarriesHostPrefix(name: string, secure: boolean): boolean {
  return !secure || name.startsWith("__Host-");
}
