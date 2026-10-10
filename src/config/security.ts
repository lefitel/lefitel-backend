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
 * oracle. Two things compare a password from inside a live session: the step-up
 * gate (`middleware/requireStepUp.ts`), on every route it guards, and
 * `updateUserPass`'s own `oldPass` check. Neither moves the per-account
 * lockout — see `verifyOwnPassword` for why a caller confirming their own
 * password must not be able to lock themselves out — so this is the whole of
 * the limit on both.
 *
 * **Five *wrong passwords*, not five requests, and the difference is the whole
 * reason the number survives.** It used to be five requests: every call counted,
 * charged before the handler evaluated anything, so a person changing their own
 * password legitimately — new one too short, try again a character longer — spent
 * the budget doing nothing wrong, and was told to wait on a bucket shared with
 * the rename. The premise written here was "nobody legitimately reaches five in
 * a quarter of an hour", and with a charge on every request that premise was
 * simply false. Only the answer that means "the password you typed is not
 * yours" costs anything now, and the two chargers keep that promise by
 * different means: `confirmCostsNothing` in `middleware/loginLimiters.ts`
 * refunds the rest for `passwordConfirmLimiter`'s own callers, while the
 * step-up gate charges the store directly and refunds a right answer on the
 * spot — see `consumirCupoDeConfirmacion` in that same file.
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
 * **One bucket for every door onto that secret, deliberately** — see
 * `usuario.routes.ts`. The step-up gate guards many routes and
 * `updateUserPass` compares its own `oldPass`, but there is one password
 * behind all of them; counting each door separately would hand out a fresh
 * five a quarter of an hour to anybody willing to alternate. Sharing is what
 * made the old charge-everything rule hurt (an operation you could not perform
 * because you had been fighting the password form) and the refund is what
 * fixes that, rather than splitting the bucket and giving the guesser more.
 */
export const PASSWORD_CONFIRM_LIMIT = 5;

/**
 * How many WebAuthn ceremony requests one session may make per
 * `LOGIN_WINDOW_MS`.
 *
 * 🔴 **This bucket is not about guessing, it is about writing.** A failed
 * assertion deliberately costs nothing against the account lockout (decision
 * D7 of plan 4C) and, in exchange, every one of them writes a bitácora line.
 * With no bucket, somebody holding a stolen cookie has a free, unbounded
 * INSERT primitive into the one table nothing in `src/` ever prunes — and the
 * flood would drown the very signal that line was added to give. Minting the
 * challenge has the same shape: one `reto_webauthn` row per call.
 *
 * Thirty is deliberately generous against real use. A login is one `options`
 * plus one `verify`; a step-up window reopens at most every
 * `STEP_UP_WINDOW_MINUTES`, so a person working steadily for a quarter of an
 * hour spends six or eight. Nobody reaches thirty by using the product.
 */
export const WEBAUTHN_CEREMONY_LIMIT = 30;

/**
 * How many times one address may ask for passwordless login options per
 * `LOGIN_WINDOW_MS` — `POST /api/auth/webauthn/passwordless/options`, plan
 * 4C phase 2, Task 14.
 *
 * **Keyed by address, and that is a known cost rather than a choice.** The
 * bucket above is keyed by session because "the whole office is one NAT";
 * here there is no session and no account — nobody is named until a
 * signature verifies — so the address is all there is, and this number is a
 * budget for the *building*, not for a person. Every request counts,
 * successes included, because a success is the write this bounds: one
 * `reto_webauthn` row per call, two minutes long.
 *
 * **The number, defended.** Twenty people behind one address, morning rush,
 * one quarter-hour window. A login is one `options`; a cancelled system
 * dialog (the person closes it, or Safari's activation window lapses) is a
 * second; a two-minute challenge that expires while somebody finds their
 * phone is a third. At three per person that is sixty — and a hundred, the
 * first draft, left the whole building forty requests of headroom shared
 * with anybody retrying in a loop. Three hundred is five per person per
 * quarter hour with room for a bad morning, and what it protects — a table
 * of tiny rows the ceremony itself purges — costs nothing at that rate.
 *
 * What it cannot do: tell a guest on the office wifi from staff. A hostile
 * insider on the LAN can empty this bucket with a loop, the same way they
 * can empty `LOGIN_IP_LIMIT` with a loop of wrong passwords, and that is
 * out of scope for a rate limit. What keeps a *visitor's browser* from
 * spending it on the office's behalf is `requireVerifiedOrigin` on the
 * route, not this number.
 */
export const WEBAUTHN_PASSWORDLESS_OPTIONS_LIMIT = 300;

/**
 * How many *refused* passwordless assertions one address may send per
 * `LOGIN_WINDOW_MS` — `POST /api/auth/webauthn/passwordless/verify`.
 *
 * Refused ones only: a login that works is not a failed attempt and is
 * refunded, the same rule as `LOGIN_IP_LIMIT`. What a refusal costs the
 * server is one signature verification at most, and what it can write is one
 * bitácora line against the account the credential names — the per-account
 * ceiling on *those* lives in `WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT`,
 * because an address bucket cannot see a flood spread across addresses.
 *
 * Fifty rather than thirty, for a failure that is not an attack: a wrong
 * `WEBAUTHN_RP_ID` or `WEBAUTHN_ORIGIN` after a deploy makes *every*
 * assertion fail with a 400, not a 5xx, so nothing is refunded and twenty
 * people trying twice each would have shut the door for the rest of the
 * quarter hour with "Demasiados intentos" — the wrong diagnosis, sending
 * everybody to support for the wrong reason. Fifty is still a ceiling
 * nobody reaches by using the product: a legitimate assertion fails
 * essentially never, since a cancelled dialog never reaches the server.
 */
export const WEBAUTHN_PASSWORDLESS_VERIFY_LIMIT = 50;

/**
 * How many `WEBAUTHN_ASSERTION_FAILED` lines the passwordless door may write
 * against **one account** per `LOGIN_WINDOW_MS` before it stops writing them
 * one by one — see `auth/failedAssertionBudget.ts`.
 *
 * 🔴 **The address buckets cannot bound this, by construction.** A refused
 * anonymous assertion that names a real credential writes a line against
 * that credential's owner — the other half of decision D7, same as in phase
 * 1. In phase 1 the caller needed a stolen cookie to reach that line; in
 * phase 2 they need a `credential_id`, which sits in plain text in every
 * ceremony the victim's own browser ever ran. From one address that is
 * `WEBAUTHN_PASSWORDLESS_VERIFY_LIMIT` lines a quarter hour; from an IPv6
 * /48 it is thousands an hour, all filed as `warning` under the victim's
 * name, in a table nothing prunes — enough to bury the one real line among
 * them. This is the budget that follows the *account* instead of the
 * address, and it bounds the writing, never the refusing: past it the door
 * keeps saying no, and writes one line saying how many it stopped counting.
 * Bounding the refusal instead would hand the attacker a way to shut the
 * victim's passkey login with a loop.
 *
 * Ten: a person cannot produce that many refused assertions by hand in a
 * quarter hour, and ten lines already say everything the eleventh would.
 */
export const WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT = 10;

/*
 * ── The login code by email (plan 4E) ──────────────────────────────────────
 *
 * Six digits sent to a verified address, a second factor on its own since
 * 2026-09-03. Every number below is an argument, not a knob; the design
 * (`docs/specs/2026-09-03-correo-como-factor-y-relevo-de-correo-design.md`,
 * §3.3) has the table.
 */

/**
 * How long a code stays redeemable. Ten minutes: mail takes a while to
 * arrive, and anything longer only widens the window a guesser has for a
 * space of a million values.
 */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses a code survives. Five, charged **before** the compare by the
 * same statement that reads the hash (`auth/emailCodeStore.ts`), so that
 * five requests arriving in the same tick are still five and not N. Five of
 * a million is 0.0005 % per code, and every wrong guess also charges the
 * account lockout the way a wrong TOTP does.
 */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/**
 * Seconds between two codes for the same account. A nervous second click
 * should not spend the company's mail quota; sixty is under the point where
 * somebody honestly gives up waiting for the first one.
 */
export const EMAIL_CODE_RESEND_SECONDS = 60;

/**
 * Codes per account per hour, and per day. Both live in the database
 * (`codigo_correo.created_at`), not in a process bucket: a restart forgets
 * nothing, and a second process would see the same numbers.
 *
 * The hourly cap alone does not bound the day — five an hour is 120 a day,
 * a quarter of the whole mail chain's budget for one account — which is what
 * the daily cap is for. Twelve a day is more than anybody logging in from
 * three devices with a slow mailbox needs, and a tenth of what one account
 * could otherwise burn.
 */
export const EMAIL_CODE_HOURLY_LIMIT = 5;
export const EMAIL_CODE_DAILY_LIMIT = 12;

/**
 * Verification attempts per account per quarter hour, on `/mfa/verify` and
 * `/stepup` with `metodo: "correo"`, checked **before** anything touches the
 * database. Per-code attempts are charged atomically in the row; this bucket
 * bounds what those attempts cost the *server*: each one is a `bcrypt.compare`
 * at `BCRYPT_COST` — also on the "no code pending" path, against
 * `fillerHash()`, so that timing does not say whether a code exists — and a
 * session that holds the password could otherwise queue hundreds of them.
 * In memory and per process, like the login buckets: it bounds CPU, not
 * quota, and a restart that forgets it gives away nothing the row does not
 * still count.
 */
export const EMAIL_CODE_VERIFY_LIMIT = 20;

/**
 * How long a re-authentication keeps opening the sensitive operations.
 *
 * Ten minutes is long enough to create three users in a row without
 * re-authenticating, and short enough that an unlocked laptop left on a desk is
 * not a standing authorisation to edit the permission matrix.
 *
 * **One number, three jobs, and they are deliberately the same number.** It
 * bounds `sesiones.mfa_satisfied_at`, the window a proved factor opens; it
 * bounds `sesiones.password_confirmed_at`, the window a correct password opens
 * for an account that has no factor to prove; and `sellarContrasena`
 * (`auth/sessionPromotion.ts`) reads it a third time, to refuse to re-stamp a
 * window that is still inside itself — which is what makes the ten minutes run
 * from the first confirmation instead of renewing on every request. A route
 * mounted with `sinVentana` honours none of the three. See
 * `middleware/requireStepUp.ts`.
 */
export const STEP_UP_WINDOW_MINUTES = 10;

/**
 * The field a caller re-enters their current password in for the step-up gate.
 *
 * Not only the accounts with no factor: since the free-pass branch was deleted
 * (2026-09-08) every account has to send this when the gate asks, and the
 * mounts carrying `sinVentana` ask on every single request — so an account
 * that has just proved a factor sends it too.
 */
export const STEP_UP_PASSWORD_FIELD = "stepup_password";

/**
 * How long somebody has to set up a second factor before the ERP closes to
 * them, counted from their **first login after the deploy** and not from the
 * deploy itself.
 *
 * From the deploy would mean whoever is on holiday comes back on day 30 to a
 * grace period that expired without them ever seeing a screen: zero of their
 * fourteen days. Counting from their own first login also spreads the setup
 * across the days people actually come back, instead of concentrating every
 * verification email on the Saturday the deploy happened.
 *
 * Read in exactly one place — `estadoInicialDeSesion` in
 * `auth/factorInventory.ts`, which is the only thing that ever *decides* a
 * deadline. Two callers then write what it decides: `terminarLogin`
 * (`auth/finishLogin.ts`) and, since 2026-09-08, the session rotation in
 * `updateUserPass`. Still once per account — the branch that answers with a
 * date is the one for a column that has never been stamped — but no longer
 * "on the first login": whichever of the two gets there first starts the
 * clock. Because the deadline is a stored date and not
 * this number applied at read time, shortening or lengthening the constant
 * later moves nobody who has already logged in once: their fourteen days were
 * fixed the day they started.
 */
export const MFA_GRACE_DAYS = 14;

/**
 * Whether an account is *required* to have a second factor. Off unless the
 * environment says `MFA_OBLIGATORIO=true`.
 *
 * **Off is the decision, not a missing setting** (Isaias, 9 October 2026, with
 * the alternatives in front of him: the design this arc was built to —
 * "dos factores obligatorios" — and mandatory for administrators only). With
 * it off, a second factor is something a person chooses to set up. An account
 * that has one is still asked for it at every login; an account that has none
 * logs in with its password, for as long as it likes.
 *
 * **What turning it on does** is everything `MFA_GRACE_DAYS` above describes:
 * the first login stamps a deadline, and past it the ERP closes to that account
 * until it registers a factor. None of that machinery was removed — it is
 * dormant, and the test suite still runs with this on (`vitest.config.ts`)
 * precisely so it does not rot while nobody is using it.
 *
 * **It is read in exactly two places, and both have to agree:**
 * `estadoInicialDeSesion` (`auth/factorInventory.ts`), which decides at login,
 * and `estadoEfectivo` (`auth/sessionState.ts`), which re-decides on every
 * request. Off, the first never stamps a deadline and the second never acts on
 * one — including a deadline stamped while this was on, so switching it off
 * frees everybody at their next request rather than only people who had never
 * logged in.
 *
 * A function and not a constant, like the mail and keyring settings in this
 * file: read when asked, so a test can flip it with `vi.stubEnv`.
 *
 * Exactly `"true"`. Anything else — unset, empty, `1`, `yes` — is off, because
 * the failure worth avoiding is a typo closing the ERP to the whole company a
 * fortnight later.
 */
export function mfaObligatorio(): boolean {
  return process.env.MFA_OBLIGATORIO === "true";
}

/**
 * How long `--reset-mfa` (and its endpoint twin, `POST
 * /usuario/:id/mfa/reset`) extends `usuarios.mfa_grace_until` by, once it has
 * cleared an account's factors.
 *
 * **Never a reduction — that is the whole reason this is a duration and not a
 * date.** `auth/rescueCore.ts`'s `proximaGraciaDeRescate` takes whatever
 * deadline the account already had and this many hours from now, and keeps
 * the later of the two. Written as a plain assignment instead, this makes
 * things worse for almost everyone it touches: 0 of the accounts in
 * production have `mfa_grace_until` set at all on deploy day, so the login
 * stamps `MFA_GRACE_DAYS` (fourteen days) on each one's first login: a
 * technician with twelve of those fourteen days left who loses their phone
 * and gets rescued would have that twelve cut down to one, and land in
 * `onboarding` — answering 403 to almost everything — the day after being
 * "rescued". See §8 of the design and finding H1 of the pre-audit that
 * caught it before it shipped.
 */
export const RESCUE_GRACE_HOURS = 24;

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

/**
 * AES-256-GCM parameters for the TOTP secret's encryption (`auth/mfaCrypto.ts`
 * and `auth/mfaKeyring.ts`), named here rather than left as bare numbers
 * inside those modules because two of them are mirrored by a Postgres
 * `CHECK` written independently, in the migration that created
 * `factor_totp`: `factor_totp_iv_len_chk` (`octet_length(iv) = 12`) and
 * `factor_totp_tag_len_chk` (`octet_length(auth_tag) = 16`). A magic number
 * living in two files with nothing tying them together is exactly the drift
 * this file's own header warns about — the bcrypt cost that went from 8 to
 * 12 while two of its three call sites did not notice. If either of these
 * ever needs to change, the DB constraint is the other place to look.
 *
 * `MFA_ENCRYPTION_KEY_BYTES` is AES-256's own key length. The keyring uses
 * it to reject anything else — including the 65-hex-character typo that
 * `Buffer.from(x, 'hex')` would otherwise decode to exactly 32 bytes by
 * silently dropping the last nibble (finding B2, measured in
 * `auth/mfaKeyring.ts`'s own comment).
 */
export const MFA_ENCRYPTION_KEY_BYTES = 32;
export const MFA_IV_BYTES = 12;
export const MFA_AUTH_TAG_BYTES = 16;

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
  // MAIL_PROVIDERS and MAIL_FROM: with no chain configured, `auth/mailer.ts`
  // answers `{ ok: true }` without sending anything — the development
  // fallback. That fallback is exactly wrong in production: every
  // verification, reset and login-code email would silently no-op, and the
  // first sign of it would be a person who never got their link. Refusing to
  // boot is what turns that into a deploy-time failure instead of a support
  // ticket. **`RESEND_API_KEY` left this list with plan 4E**: demanding it
  // would refuse a perfectly valid deployment of four SMTP providers and no
  // Resend. Which credentials each listed provider needs is decided by
  // `configuracionDeCorreo` below from the *value* of `MAIL_PROVIDERS`, and
  // this list cannot do that — the same split `MFA_ENCRYPTION_KEY_ACTIVE` has
  // two paragraphs down. `index.ts` runs that value check at boot.
  //
  // MFA_ENCRYPTION_KEY_ACTIVE: which entry of the keyring in
  // `auth/mfaKeyring.ts` encrypts. Without a usable key the TOTP secret can be
  // written and never read back again.
  //
  // 🔴 **This names the pointer, never a key.** Requiring `MFA_ENCRYPTION_KEY_1`
  // — which is what the plan first asked for — contradicts the rotation
  // procedure the same plan documents, whose final step removes exactly that
  // variable: a rotation done perfectly would then refuse the next production
  // boot. And this list cannot name the right one instead, because deciding a
  // variable's *name* from another variable's *value* is not something a
  // function whose contract is "a plain list of names, given only `nodeEnv`"
  // can do.
  //
  // So the split is the same one `COOKIE_NAME` already uses two paragraphs up:
  // this list proves the variable was *set*, and `index.ts` runs the *value*
  // check separately at boot — there, `llaveActiva()` resolves the pointer and
  // throws by name if it points at a key that is absent or malformed. Presence
  // here, meaning there. Neither half is enough alone.
  return nodeEnv === "production"
    ? [
        "CORS_ORIGIN",
        "COOKIE_NAME",
        "COOKIE_SECURE",
        "MAIL_PROVIDERS",
        "MAIL_FROM",
        "MFA_ENCRYPTION_KEY_ACTIVE",
        // 🔴 The two passkey values, and they are on this list for a reason
        // no other entry has: **neither can be corrected after the fact.**
        // Every other variable here, set wrong, is fixed by setting it right
        // and restarting. A passkey registered under the wrong Relying Party
        // id stops existing the moment the id is corrected, and has to be
        // enrolled again on every device by every person. Refusing to boot is
        // the only failure mode that cannot be shipped by accident — see
        // `webauthnRpId` for why the value is `www.osefi.net` and not the
        // apex, and `webauthnOrigins` for why this is not the CORS list.
        "WEBAUTHN_RP_ID",
        "WEBAUTHN_ORIGIN",
      ]
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
 * The oldest a *revoked* remembered device is allowed to get before the sweep
 * takes it, however much life its own `expires_at` had left.
 *
 * A ceiling, not a promise, and the distinction is the whole of it. Revoking
 * does not delete the row — it stays for the sessions screen and for anyone
 * asking what was cut off — but a device cookie is deliberately long-lived,
 * which is the entire point of "do not ask me again on this machine", and a
 * device that has been cut off has no business holding an IP address and a user
 * agent for the rest of a lifetime measured in months. So a revoked row goes at
 * its own expiry or thirty days after the revocation, **whichever comes first**.
 *
 * Which makes it emphatically not a floor: a device revoked five days before
 * its cookie was going to lapse anyway is gone in five days, not thirty.
 * `purgeExpiredSessions` reads differently — it applies its cutoff to all three
 * of its branches — and the difference is deliberate rather than an omission: an
 * expired device is dead weight holding personal data, and there is no reason to
 * keep it one day past the day it stopped working. If a durable record of a
 * revocation is ever wanted it belongs in the bitácora, which `deleteUsuario`
 * already writes, and not in a table every row of which deletes itself.
 */
export const REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS = 30;

/**
 * How often `purgeExpiredRememberedDevices` runs once the process has booted.
 *
 * Its own constant rather than a reuse of `SESSION_PURGE_INTERVAL_MS`, because
 * the two sweeps are scheduled independently (see `index.ts`) and only one of
 * them holds personal data. The day this one needs to run more often, it can —
 * without that being a decision about sessions.
 */
export const REMEMBERED_DEVICE_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The name of the "remember this device" cookie — `auth/rememberedDeviceIssue.ts`.
 *
 * Its own name and not a second use of `SESSION_COOKIE_NAME`: the two cookies
 * answer different questions (which session is this vs. has this browser
 * already proved a factor) and a browser has to be able to hold, and clear,
 * one without touching the other. No `__Host-` prefix — that prefix demands
 * `path=/`, and this cookie's whole point is a `Path` scoped to the login
 * route (see `rememberedDeviceIssue.ts`), so it could never carry it anyway.
 */
export const REMEMBERED_DEVICE_COOKIE_NAME = "osefi_remember_device";

/**
 * How long a minted "remember this device" cookie is trusted for, in days.
 *
 * Thirty, the same figure Decision 4 of the MFA plan reasons about throughout
 * — including in `REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS` above, which caps
 * how long a *revoked* row's personal data survives, not how long a live one
 * is honoured. This constant is the other one: it is what
 * `rememberedDeviceIssue.ts` writes into a fresh row's `expires_at`, and what
 * the cookie itself is told to expire at, so the two can never disagree about
 * how long "do not ask me again on this machine" means.
 */
export const REMEMBERED_DEVICE_TTL_DAYS = 30;

/**
 * The login body field that asks for a "remember this device" cookie.
 *
 * Named `recordar` to match the field the design spec already gives
 * `/auth/mfa/verify` for the same request, so a later plan wiring that
 * endpoint does not have to invent a second spelling of the same idea. Read
 * only by `login` today, and only ever after the second factor is already
 * proven — see that handler for why a login can only ever have one moment
 * where that is true.
 */
export const REMEMBER_DEVICE_FIELD = "recordar";

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
 * How long a WebAuthn challenge stays redeemable.
 *
 * Two minutes, and it is short for a different reason than the two above.
 * Those cross an inbox: somebody has to receive a mail, find it, and click.
 * A challenge never leaves the browser that asked for it — it is minted,
 * handed straight to `navigator.credentials`, and answered by a fingerprint
 * within seconds. The only thing a longer window buys is a wider replay
 * window for an assertion somebody captured.
 *
 * 🔴 **And for a synced passkey this window is the whole replay defence**, not
 * a second layer. iCloud Keychain and Google Password Manager report a
 * signature counter of 0 on every assertion, so `esContadorDeClon` in
 * `auth/passkeyStore.ts` can never catch a clone of one. What stops a captured
 * assertion being replayed is that its challenge was spent — see
 * `consumirReto`.
 *
 * Two minutes rather than one because the ceremony is not always instant: a
 * security key has to be found in a drawer, a phone has to be picked up and
 * unlocked, and a person prompted for a fingerprint at the wrong moment
 * looks away and comes back. One minute would turn those into a failure that
 * reads like a broken passkey.
 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 2 * 60 * 1000;

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
 * ~~`PASSWORD_FORGOT_DAILY_LIMIT` / `PASSWORD_FORGOT_DAILY_WINDOW_MS`~~ —
 * retiradas por la revisión final, y anotadas en vez de borradas porque el
 * error que representaban es fácil de repetir.
 *
 * Eran el tope de un `express-rate-limit` con clave global montado delante de
 * `/password/forgot`. El middleware corre antes que el handler, así que solo
 * podía contar **peticiones** — y la petición no es el recurso. Cincuenta POST
 * con el cuerpo mal formado contestaban 400, no mandaban ni un correo, no
 * gastaban nada de la cuota de Resend, y dejaban a toda la empresa sin
 * recuperación veinticuatro horas, con `RateLimit-Remaining` llevándole la
 * cuenta al atacante.
 *
 * El techo que buscaban vive ahora en el cupo de cada proveedor de correo
 * (`configuracionDeCorreo` más abajo, `auth/mailBudget.ts`), contado en el
 * sitio donde el correo se manda de verdad. Plan 4E lo volvió a discutir —la
 * recuperación sin credencial podía vaciar la cadena entera y dejar sin
 * login a quien solo tiene correo— y la respuesta fue la **reserva** por
 * proveedor (`MAIL_RESERVA_FRACCION`), no otro cubo de peticiones.
 */
export const MAIL_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/*
 * ── The mail chain (plan 4E) ───────────────────────────────────────────────
 *
 * Five providers with relay: Resend by its API and four more by SMTP through
 * one adapter. The design (`docs/specs/2026-09-03-correo-como-factor-y-relevo-de-correo-design.md`
 * §4) argues every number below; `auth/mailRelay.ts` and
 * `auth/mailProviders.ts` read them.
 */

/**
 * The share of each provider's daily ceiling that only the reserved flows
 * may spend — the login code and the security notices (`FLUJOS_RESERVADOS`
 * in `auth/mailBudget.ts`). A quarter: the old single budget held 20 of
 * Resend's 100 back for the takeover warnings, and since a verified address
 * is a second factor the same headroom is what keeps `/password/forgot` —
 * which asks for no credential — from spending the login out of existence.
 */
export const MAIL_RESERVA_FRACCION = 0.25;

/**
 * How long a provider is sidelined after two outage-shaped failures in a
 * row. Fifteen minutes: long enough not to hammer a provider that is down,
 * short enough that the next login after an outage finds it back.
 */
export const MAIL_PROVIDER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Deadlines. `MAIL_PLAZO_INTERACTIVO_MS` bounds the whole walk of the chain
 * when a person is waiting on the screen — the login code, the verification
 * link, the rescue notice that runs before the rescue itself. Twelve seconds
 * is under the point where somebody clicks again. `MAIL_PLAZO_DIFERIDO_MS` is
 * for the flows nobody waits on (`/password/forgot`, notices after the
 * response). `MAIL_PLAZO_POR_INTENTO_MS` bounds one provider: nodemailer's
 * own timers are per phase and a server that answers each step just under
 * its limit would otherwise hold the login for their sum. Eight and not ten
 * (audit of Task 7): with twelve for the whole walk, ten left the second
 * provider two seconds — less than a connection takes — so it was charged an
 * ambiguous attempt that could not have sent anything, and the third was
 * never reached. `MAIL_PLAZO_MINIMO_INTENTO_MS` is the floor under which the
 * walk stops instead of starting an attempt that cannot finish: a connection
 * and a greeting, the two phases before anything is sent.
 */
export const MAIL_PLAZO_INTERACTIVO_MS = 12_000;
export const MAIL_PLAZO_DIFERIDO_MS = 60_000;
export const MAIL_PLAZO_POR_INTENTO_MS = 8_000;
export const MAIL_PLAZO_MINIMO_INTENTO_MS = 4_000;

/**
 * Attachments — the scheduled reports are the only messages that carry one.
 *
 * `MAIL_ADJUNTOS_MAX_BYTES` is the ceiling for everything attached to one
 * message, counted as raw bytes before encoding. Ten megabytes and not the
 * 25 the exporter allows (`MAX_EXPORT_BYTES`): base64 adds a third, and the
 * message has to fit the strictest provider on the chain whichever one ends
 * up carrying it — a file that only the first provider accepts would turn
 * every relay into a refusal. The relay checks it before asking anybody, so
 * an oversized file costs no attempt and no quota. Measured on the real data
 * the general report is 96 KB as a workbook, 1,8 MB with its 1.955
 * photographs and 4,0 MB as a document.
 *
 * `MAIL_PLAZO_POR_INTENTO_CON_ADJUNTO_MS` replaces the eight seconds above for
 * a message that carries a file. Eight seconds is sized for a six-digit code;
 * megabytes cut off at eight would be filed `ambiguo` — charged, relayed to
 * the next provider, and quite possibly delivered twice. Nobody is waiting on
 * a screen for these.
 */
export const MAIL_ADJUNTOS_MAX_BYTES = 10 * 1024 * 1024;
export const MAIL_PLAZO_POR_INTENTO_CON_ADJUNTO_MS = 90_000;

/**
 * nodemailer's per-phase timeouts, replacing its defaults of two minutes per
 * connection, thirty seconds per greeting and ten minutes per socket.
 */
export const MAIL_SMTP_CONNECTION_TIMEOUT_MS = 4_000;
export const MAIL_SMTP_GREETING_TIMEOUT_MS = 4_000;
export const MAIL_SMTP_SOCKET_TIMEOUT_MS = 8_000;
export const MAIL_SMTP_DNS_TIMEOUT_MS = 3_000;

/**
 * The SMTP providers this deployment knows by name: host, port, and the
 * headers that turn their click and open tracking off **per message** —
 * the two that have such headers. Tracking rewrites every link through the
 * provider's domain, and the verification and reset links carry their token
 * in the URL; a rewritten link is that token in a third party's click log.
 * The other two (SMTP2GO, Mailtrap) only turn it off in their panel, which
 * the runbook demands before the first real send.
 *
 * Verified against each provider's documentation on 2026-09-03; the
 * credential convention each one uses is in `.env.example`.
 */
export const SMTP_CONOCIDOS: Readonly<Record<string, { host: string; puerto: number; cabeceras: Readonly<Record<string, string>> }>> = {
  mailjet: {
    host: "in-v3.mailjet.com",
    puerto: 587,
    cabeceras: { "X-Mailjet-TrackOpen": "0", "X-Mailjet-TrackClick": "0" },
  },
  smtp2go: { host: "mail.smtp2go.com", puerto: 587, cabeceras: {} },
  mailtrap: { host: "live.smtp.mailtrap.io", puerto: 587, cabeceras: {} },
  elastic: {
    host: "smtp.elasticemail.com",
    puerto: 587,
    cabeceras: { trackopens: "false", trackclicks: "false" },
  },
};

/**
 * Daily ceilings outside production when `MAIL_<NAME>_DAILY` is not set —
 * the free tiers measured on 2026-09-03 minus a margin. In production the
 * variable is required: the ceiling is a promise to the provider, and a
 * default nobody typed is not a promise anybody made.
 */
export const MAIL_CUPOS_POR_DEFECTO: Readonly<Record<string, number>> = {
  resend: 80,
  mailjet: 180,
  smtp2go: 30,
  mailtrap: 120,
  elastic: 80,
};

export type ProveedorConfigurado =
  | { tipo: "resend"; nombre: "resend"; claveVar: "RESEND_API_KEY"; cupoDiario: number }
  | {
      tipo: "smtp";
      nombre: string;
      host: string;
      puerto: number;
      usuarioVar: string;
      passVar: string;
      cupoDiario: number;
      cabeceras: Readonly<Record<string, string>>;
    };

// The `?: undefined` keys are what let `if (!config.ok)` narrow under this
// repo's `strictNullChecks: false`.
export type ConfiguracionDeCorreo =
  | {
      ok: true;
      modo: "envia" | "desarrollo";
      from: string | null;
      proveedores: ProveedorConfigurado[];
      /** Providers named in `MAIL_PROVIDERS` that could not be built, and why — variable names only. */
      descartados: { nombre: string; motivo: string }[];
      errores?: undefined;
    }
  | {
      ok: false;
      errores: string[];
      modo?: undefined;
      from?: undefined;
      proveedores?: undefined;
      descartados?: undefined;
    };

function enteroPositivo(valor: string | undefined): number | null {
  if (valor === undefined || valor.trim() === "") return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The mail chain, read from the environment — **pure, and it never returns a
 * secret.** Every provider is described by the *names* of the variables that
 * hold its credentials (`usuarioVar`, `passVar`, `claveVar`), so the whole
 * object can be written to the boot log and the adapters read the values at
 * send time.
 *
 * The rules, and why each is where it is:
 *
 * - `MAIL_PROVIDERS` is the order of the relay. In production `requiredEnv`
 *   already demands it; here an empty or missing list outside production is
 *   development mode, with one convenience: `RESEND_API_KEY` plus `MAIL_FROM`
 *   and no list means `resend`, with a note, so the `.env` this repo shipped
 *   with keeps sending.
 * - A listed provider with an incomplete configuration is **dropped, not
 *   fatal**, and reported in `descartados` by variable name. `index.ts` logs
 *   each one at `fatal` level in production — the first screen of the log —
 *   and boots anyway, because a chain of four is a degraded chain and a
 *   process that refuses to start over a typo is an outage for nine people
 *   whose only second factor is now the email. Only an **empty** chain in
 *   production is `ok: false`: that is the silent no-send `requiredEnv`
 *   exists to turn into a deploy failure.
 * - A name in `SMTP_CONOCIDOS` needs `USER`, `PASS` and (in production)
 *   `DAILY`; its host, port and headers come from the table unless
 *   overridden. Any other name is accepted with a full configuration —
 *   `HOST`, `PORT`, `USER`, `PASS`, `DAILY` — and no headers: a provider
 *   nobody wrote code for is variables, not code.
 * - `requiredEnv` cannot do this check: it decides variable names from the
 *   environment string alone, and these names depend on another variable's
 *   value — its own docblock says so.
 */
export function configuracionDeCorreo(
  env: NodeJS.ProcessEnv,
  nodeEnv: string | undefined,
): ConfiguracionDeCorreo {
  const produccion = nodeEnv === "production";
  const from = env.MAIL_FROM?.trim() || null;
  const descartados: { nombre: string; motivo: string }[] = [];
  let nombres = (env.MAIL_PROVIDERS ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== "");

  if (nombres.length === 0) {
    if (produccion) {
      return { ok: false, errores: ["MAIL_PROVIDERS no está configurada o está vacía"] };
    }
    if (env.RESEND_API_KEY && from) {
      nombres = ["resend"];
      descartados.push({ nombre: "MAIL_PROVIDERS", motivo: "no está; se asume resend porque RESEND_API_KEY y MAIL_FROM sí están" });
    } else {
      return { ok: true, modo: "desarrollo", from, proveedores: [], descartados };
    }
  }
  if (!from) {
    if (produccion) return { ok: false, errores: ["MAIL_FROM no está configurada"] };
    return { ok: true, modo: "desarrollo", from: null, proveedores: [], descartados: [{ nombre: "MAIL_FROM", motivo: "no está; modo desarrollo" }] };
  }

  const proveedores: ProveedorConfigurado[] = [];
  const vistos = new Set<string>();
  for (const nombre of nombres) {
    if (vistos.has(nombre)) {
      descartados.push({ nombre, motivo: "repetido en MAIL_PROVIDERS" });
      continue;
    }
    vistos.add(nombre);

    if (nombre === "resend") {
      const faltan: string[] = [];
      if (!env.RESEND_API_KEY) faltan.push("RESEND_API_KEY");
      const cupo = enteroPositivo(env.MAIL_RESEND_DAILY) ?? (produccion ? null : MAIL_CUPOS_POR_DEFECTO.resend);
      if (cupo === null) faltan.push("MAIL_RESEND_DAILY (entero mayor que 0)");
      if (faltan.length > 0 || cupo === null) {
        descartados.push({ nombre, motivo: `faltan: ${faltan.join(", ")}` });
        continue;
      }
      proveedores.push({ tipo: "resend", nombre: "resend", claveVar: "RESEND_API_KEY", cupoDiario: cupo });
      continue;
    }

    const NAME = nombre.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const conocido = SMTP_CONOCIDOS[nombre];
    const hostVar = `MAIL_SMTP_${NAME}_HOST`;
    const portVar = `MAIL_SMTP_${NAME}_PORT`;
    const usuarioVar = `MAIL_SMTP_${NAME}_USER`;
    const passVar = `MAIL_SMTP_${NAME}_PASS`;
    const dailyVar = `MAIL_SMTP_${NAME}_DAILY`;
    const faltan: string[] = [];
    const host = env[hostVar]?.trim() || conocido?.host || null;
    if (!host) faltan.push(hostVar);
    const puertoCrudo = env[portVar]?.trim();
    const puerto = puertoCrudo ? enteroPositivo(puertoCrudo) : (conocido?.puerto ?? null);
    if (puerto === null || puerto > 65535) faltan.push(`${portVar} (entero entre 1 y 65535)`);
    if (!env[usuarioVar]) faltan.push(usuarioVar);
    if (!env[passVar]) faltan.push(passVar);
    const cupo = enteroPositivo(env[dailyVar]) ?? (produccion ? null : (MAIL_CUPOS_POR_DEFECTO[nombre] ?? null));
    if (cupo === null) faltan.push(`${dailyVar} (entero mayor que 0)`);
    if (faltan.length > 0 || host === null || puerto === null || cupo === null) {
      descartados.push({ nombre, motivo: `faltan: ${faltan.join(", ")}` });
      continue;
    }
    proveedores.push({
      tipo: "smtp",
      nombre,
      host,
      puerto,
      usuarioVar,
      passVar,
      cupoDiario: cupo,
      cabeceras: conocido?.cabeceras ?? {},
    });
  }

  if (proveedores.length === 0) {
    if (produccion) {
      return {
        ok: false,
        errores: descartados.map((d) => `MAIL_PROVIDERS lista "${d.nombre}", pero ${d.motivo}`),
      };
    }
    return { ok: true, modo: "desarrollo", from, proveedores: [], descartados };
  }
  return { ok: true, modo: "envia", from, proveedores, descartados };
}

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

/**
 * The Relying Party id the passkeys of this ERP are bound to.
 *
 * **What this value is.** WebAuthn ties every credential to one domain and
 * refuses to use it anywhere else. That refusal is enforced by the browser
 * before anything reaches this server, and it is the entire reason a passkey
 * cannot be phished: a page on `osefi-net.com` asking for the fingerprint
 * gets nothing, because the domain does not match. There is no fallback path
 * for a user to override, which is exactly the point.
 *
 * 🔴 **Why `www.osefi.net` and not the apex `osefi.net`.** Revision 1 of the
 * design chose the apex, arguing it "covers www.osefi.net and api.osefi.net
 * at once". That argument is false in its premise: `api.osefi.net` serves no
 * pages and never runs a ceremony — it only verifies assertions server-side,
 * where the id is a parameter it is handed, not something it hosts. So the
 * apex covered nothing extra, and in exchange it would let **any**
 * `*.osefi.net` ask for the fingerprint under the company's own branding and
 * relay the assertion. `middleware/csrf.ts` already documents that
 * `evil.osefi.net` is not hypothetical here: one mis-delegated DNS record is
 * enough, and a subdomain is same-site, so `SameSite=Lax` does not stop it.
 *
 * The cost of the narrow choice would be that `https://osefi.net` cannot run
 * a ceremony at all — an id must equal the page's domain or be a registrable
 * suffix of it, and `www.osefi.net` is not a suffix of `osefi.net`. Measured
 * on 2026-09-02: `https://osefi.net` answers `307` to
 * `https://www.osefi.net/`. Nobody ever executes a ceremony on the apex, so
 * the cost is zero.
 *
 * 🔴 **This value cannot be changed later.** Every passkey already registered
 * under the old id stops existing as far as the server is concerned, and each
 * one has to be enrolled again by hand. That is why there is no default for
 * production: `requiredEnv` makes the process refuse to boot without it,
 * which is the only failure mode that cannot be shipped by accident.
 *
 * Development gets `localhost` — the one host browsers exempt from the
 * secure-context requirement. `127.0.0.1` is **not** exempt and does not
 * work, which is why the dev origin is written as a host name everywhere.
 */
export const DEV_WEBAUTHN_RP_ID = "localhost";

/**
 * The name the browser shows in its own passkey dialog: "Save a passkey for
 * **Osefi**?".
 *
 * A constant and not an environment variable, unlike the two values below it,
 * and the difference is worth stating because they look like a set of three.
 * Those two are security parameters whose mistakes are permanent. This one is
 * a label: getting it wrong shows the wrong word in a dialog and is fixed by
 * changing it. Making it configurable would add a third thing a deployment can
 * forget, in exchange for nothing anybody wants to vary per environment.
 */
export const WEBAUTHN_RP_NAME = "Osefi";

export function webauthnRpId(raw: string | undefined, nodeEnv: string | undefined): string {
  const configured = raw !== undefined && raw.trim() !== "";
  if (configured) return raw.trim();
  return nodeEnv === "development" ? DEV_WEBAUTHN_RP_ID : "";
}

/**
 * The origins allowed to run a passkey ceremony for this Relying Party.
 *
 * **A `Set`, and membership — never a prefix, never a suffix.** The same
 * discipline `requireSameOrigin` is built on, and for the same measured
 * reason written there: suffix matching is how `https://evil-osefi.net`
 * passes a check written for `osefi.net`. Here the stakes are higher than a
 * CSRF refusal, because the value this guards is an authentication decision.
 *
 * 🔴 **Deliberately not `allowedOrigins`, even though the lists will look
 * identical in production.** They answer different questions: that one says
 * which origins this API replies to, this one says which pages may execute a
 * ceremony for these credentials. The day `CORS_ORIGIN` gains a staging or
 * preview host — an ordinary, uncontroversial edit nobody would route past
 * this file — that host would silently become a valid origin for everybody's
 * passkeys. Two lists that happen to agree are not one list.
 *
 * A trailing slash is trimmed because it is a configuration typo, not a
 * relaxation: a browser never reports an origin with one, so a value written
 * `https://www.osefi.net/` would match nothing and every ceremony would fail
 * with no explanation. Trimming the input is not the same thing as loosening
 * the comparison, which stays exact.
 */
export function webauthnOrigins(raw: string | undefined, nodeEnv: string | undefined): Set<string> {
  const configured = raw !== undefined && raw.trim() !== "";
  if (!configured) {
    return nodeEnv === "development" ? new Set([DEV_FRONTEND_ORIGIN]) : new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter((origin) => origin !== "" && origin !== "*"),
  );
}
