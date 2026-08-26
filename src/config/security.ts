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
 * How many times an account may re-type its own password to confirm something,
 * per `LOGIN_WINDOW_MS`.
 *
 * A different budget from the two above and not a copy of them, because it is
 * the *only* thing standing between a stolen session and an unlimited password
 * oracle. Renaming your own account and changing your own password both compare
 * a password, and neither moves the per-account lockout — see `verifyOwnPassword`
 * for why a caller confirming their own password must not be able to lock
 * themselves out — so this is the whole of the limit on both.
 *
 * **Five *wrong passwords*, not five requests, and the difference is the whole
 * reason the number survives.** It used to be five requests: every call counted,
 * charged before the handler evaluated anything, so a person changing their own
 * password legitimately — new one too short, try again a character longer — spent
 * the budget doing nothing wrong, and was told to wait on a bucket shared with
 * the rename. The premise written here was "nobody legitimately reaches five in
 * a quarter of an hour", and with a charge on every request that premise was
 * simply false. `confirmCostsNothing` in `middleware/loginLimiters.ts` is what
 * makes it true: only the answer that means "the password you typed is not
 * yours" costs anything.
 *
 * So the two sides of the number are:
 *
 * - Five wrong attempts at your own current password in a quarter of an hour is
 *   the same threshold `LOCKOUT_AFTER_FAILURES` puts on the login for the same
 *   event, and the answer when it bites says to wait rather than that the
 *   password is wrong.
 * - Five per quarter hour is twenty an hour against a bcrypt hash at
 *   `BCRYPT_COST` and a password of at least `PASSWORD_MIN_LENGTH` characters.
 *   That is not a search.
 *
 * **What it does not do**, written down rather than left to be discovered: this
 * is an in-memory bucket, so it resets when the process restarts, and there is
 * no persistent counter behind it the way `failed_attempts` sits behind the
 * login. Somebody who holds a session cookie *and* can restart the API has
 * bigger doors than this one; somebody who only holds the cookie gets twenty an
 * hour and leaves a `PASSWORD_CONFIRM_FAILED` line in the bitácora for every
 * one of them.
 *
 * **One bucket for both routes, deliberately** — see `usuario.routes.ts`. They
 * are two doors onto one secret, and counting them separately would hand out ten
 * attempts a quarter of an hour to anybody willing to alternate. Sharing is what
 * made the old charge-everything rule hurt (a rename you could not perform
 * because you had been fighting the password form) and the refund is what fixes
 * that, rather than splitting the bucket and giving the guesser double.
 */
export const PASSWORD_CONFIRM_LIMIT = 5;

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
  // Nothing is required outside production any more. JWT_SECRET used to be
  // the one exception, required everywhere because signing and verifying
  // happened everywhere. With both gone — the session cookie is the only
  // credential now — keeping it on this list would only force every
  // environment to go on holding a secret nothing reads. See
  // docs/specs/2026-08-21-autenticacion-mfa-design.md §11 for why that secret
  // could not simply be left in place.
  //
  // COOKIE_NAME should be `__Host-osefi_session` in production. This only
  // proves it was *set* — a deployment that sets it to something without
  // the `__Host-` prefix still boots, and this list has no way to catch
  // that. `index.ts` runs the value check separately, at boot, with
  // `cookieNameCarriesHostPrefix`.
  //
  // RESEND_API_KEY and MAIL_FROM: `auth/mailer.ts` treats either one being
  // missing as "development, spend no quota" and answers `{ ok: true }`
  // without sending anything. That fallback is exactly wrong in production —
  // every verification and reset email would silently no-op, and the first
  // sign of it would be a user who never got their link. Refusing to boot
  // is what turns that into a deploy-time failure instead of a support
  // ticket. Unlike COOKIE_NAME, there is no further value check to run at
  // boot: any non-empty string is a usable attempt, and whether it is the
  // *right* key or address is Resend's problem to reject, the same way a
  // wrong CORS_ORIGIN is the browser's problem to reject.
  return nodeEnv === "production"
    ? ["CORS_ORIGIN", "COOKIE_NAME", "COOKIE_SECURE", "RESEND_API_KEY", "MAIL_FROM"]
    : [];
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
 * needs nothing at all, and this constant is exactly what `allowedOrigins`
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
 * response. There is one kind of authenticated response now — the session
 * cookie is the only credential — and this used to say "cookie or old bearer
 * token alike", which was the whole difficulty: the mechanism it replaces had
 * to work on both halves of a transition or it warned only half the users.
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
 * **Absent means "nothing to say", never "it expires now".** `authenticate`
 * sets this on every request it lets through, so the server itself no longer
 * has a case with nothing to report — it used to, for a request on the old
 * bearer token, which had no session row and which `/auth/me` answered with
 * `expires_at: null`. What remains is the wire: a proxy that drops headers it
 * does not recognise produces exactly the same absence, and a reader that took
 * that for "expired" would end a live session over a header it never received.
 * So a reader keeps whatever deadline it already had when this is missing, and
 * reschedules only on a value it actually got.
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
 * `auth/credentials.test.ts` is mocked with only `compare` and `hash` — no
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
 * How long a `token_uso_unico` row stays redeemable, by `proposito` — see
 * `crearToken` in `src/auth/tokenStore.ts`, the only place that reads these.
 *
 * Both numbers are the design spec's own (§3). An email-verification link is
 * lower stakes and gets an hour, since it sits in an inbox somebody might not
 * open right away. A password-reset link is a live credential for whoever
 * holds the mailbox it was sent to, so it stays open only long enough to be
 * used once, right now, by the person who just asked for it.
 *
 * Named here rather than left as a literal inside `crearToken` so a caller
 * cannot hand in its own expiry — the whole point of pinning the duration to
 * the purpose is that nothing downstream gets to ask for "a reset token good
 * for three days".
 */
export const EMAIL_VERIFY_TOKEN_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Budgets for the four routes that get somebody back into an account they
 * cannot fully use yet — Task 6 of `2026-08-25-correo-verificado-y-recuperacion`.
 * See `middleware/recoveryLimiters.ts` for how each number is spent, including
 * which of these charge every request and which refund one the way
 * `costsNothing` above does.
 */

/** Shared by every budget below except the daily one: the brief specifies each
 *  of these "per hour". */
export const RECOVERY_WINDOW_MS = 60 * 60 * 1000;

/**
 * `/password/forgot`, keyed by the address asked about.
 *
 * Bounds how many mails one address can be made to receive — a flood aimed at
 * a single mailbox, not a way to find out whether that mailbox has an account,
 * since the route answers the same 200 either way (Global Constraint #1).
 */
export const PASSWORD_FORGOT_EMAIL_LIMIT = 3;

/**
 * `/password/forgot`, keyed by IP.
 *
 * Bounds how many *different* addresses one caller can poke in an hour — the
 * defense against rotating the email to dodge the budget above. This is the
 * primary key for `/forgot` for the same reason it is primary for
 * `/password/reset`: it is the one the caller cannot choose their way around.
 */
export const PASSWORD_FORGOT_IP_LIMIT = 20;

/**
 * `/password/forgot`, counted against one shared key for every caller, for a
 * full day.
 *
 * Not in the brief this task implements — added after checking the two
 * numbers above against the thing they are supposed to protect: Resend's
 * quota, which is 100 sends a day for the *whole company*, shared with every
 * other feature that mails.
 *
 * ```
 * PASSWORD_FORGOT_EMAIL_LIMIT (3/h) → 72/day from one address alone, and two
 *   known addresses already clear the quota.
 * PASSWORD_FORGOT_IP_LIMIT   (20/h) → 480/day from one caller rotating
 *   addresses — near five times the quota, alone.
 * ```
 *
 * Neither bucket, sitting at its own ceiling, keeps the *daily* damage under
 * the quota that is supposed to be the point of both — so this third bucket
 * is the one that actually does. Fifty is invisible to real use (twenty to
 * sixty people, a handful of genuine resets a week) and it is what turns
 * "an attacker empties the mail quota and kills password recovery *and* email
 * verification for the rest of the day" into "an attacker spends half the
 * quota and only password recovery goes dark, only until the day rolls over".
 *
 * It is, on purpose, a bucket every caller shares — the same shape that hurt
 * once already, when a 503 refunding into a shared bucket locked the whole
 * office out of login for a quarter of an hour over a database blink. Accepted
 * here anyway, because the comparison above is the point: without this cap the
 * failure is total (both mail-sending features down, for the whole quota's
 * reset window), and with it the failure is partial and contained to the one
 * route the attacker actually hit.
 */
export const PASSWORD_FORGOT_DAILY_LIMIT = 50;
export const PASSWORD_FORGOT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `/email/send`, keyed by account — there already is a session, unlike
 *  `/password/forgot`, so there is no address to rotate around it. */
export const EMAIL_SEND_LIMIT = 5;

/**
 * `/password/reset`, keyed by IP — the primary budget.
 *
 * A token is 32 random bytes; nobody is going to guess one, so the caller
 * pounding this route with invented tokens is not trying to open an account,
 * they are running the server's most expensive undefended step —
 * `bcryptjs.hash` at `BCRYPT_COST` — for free, with no credential at all. A
 * key chosen by the caller (the token itself) is not a limiter against that:
 * every invented token opens a fresh bucket, and none of them ever fills. The
 * address is the one thing they cannot get a fresh one of on every request.
 */
export const PASSWORD_RESET_IP_LIMIT = 20;

/**
 * `/password/reset`, keyed by the token being redeemed — secondary.
 *
 * Protects one thing only: somebody who already holds a *valid* token from
 * burning retries against `validarPassword` — "too short", "too short",
 * again — rather than against a stranger guessing a 32-byte value, which the
 * IP budget above is what actually bounds.
 */
export const PASSWORD_RESET_TOKEN_LIMIT = 5;

/** `/email/verify`, keyed by account, same as `/email/send`. */
export const EMAIL_VERIFY_LIMIT = 10;

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

/**
 * Whether the session cookie is `Secure`, and why the default depends on the
 * environment instead of simply being `true`.
 *
 * It used to be `process.env.COOKIE_SECURE !== "false"` — fail closed, always.
 * Safe, and it made a fresh checkout impossible to run: with neither variable
 * set, `SESSION_COOKIE_NAME` falls back to a name without the `__Host-`
 * prefix while this said `Secure`, and `index.ts` refuses to boot on exactly
 * that combination. A developer with no `.env` for these got a FATAL line
 * about a prefix they had never heard of.
 *
 * That contradicted `requiredEnv`, one screen up, which deliberately requires
 * neither of them outside production. Promising "you do not need to set these
 * in development" and then refusing to start without them is not a strict
 * default, it is two halves of the config disagreeing.
 *
 * So: an explicit value always wins, and the fallback opens **only** for an
 * environment that has declared itself non-production. Anything else —
 * `NODE_ENV` unset, misspelled, or something nobody anticipated — still gets
 * `Secure`. The failure mode that matters is a production deployment whose
 * `NODE_ENV` is wrong, and this keeps that one closed; `requiredEnv` forces
 * the variable to be set in production anyway, so that branch is belt on top
 * of braces.
 */
const ENTORNOS_SIN_TLS = ["development", "test"];
export const SESSION_COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE !== "false"
    : !ENTORNOS_SIN_TLS.includes(process.env.NODE_ENV ?? "");

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
