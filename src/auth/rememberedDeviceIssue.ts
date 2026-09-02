// Minting and accepting the "remember this device" cookie.
//
// `dispositivo_recordado` already had a sweep and a mass revocation
// (`rememberedDeviceStore.ts`, from the 4A skeleton) — what it never had was a
// way to create a row or to ask "is this browser still remembered", because
// there was not yet any factor for a device to be remembered *instead of*.
// This module is that: the primitive `login` calls after a password checks
// out, to decide whether the second factor can be skipped, and the primitive
// it calls afterwards, to mint a fresh cookie once that factor really has
// been shown.
//
// **Two things the design spec hangs on this feature that are deliberately
// NOT built here, because they are not part of the convenience — they are
// holes.**
//
// 1. **Exempting a remembered-device login from the account lockout.** The
//    problem that exemption was meant to solve is already solved:
//    `LOCKOUT_MAX_MINUTES` is 15, so "somebody locks the boss's account for a
//    laugh" costs a quarter of an hour. What building it would open is worse:
//    `estaBloqueada` (`middleware/loginLimiters.ts`) is the only *durable*
//    defence against guessing a password, and whoever holds this cookie — a
//    stolen laptop, above all — would get unlimited guesses against it, and
//    the moment one lands, that very same cookie skips the second factor too.
//    So this module never touches the lockout, and `comprobarDispositivo`
//    below is never called before `verifyCredentials` — see `login` in
//    `auth.controller.ts` for the ordering that keeps it that way.
// 2. **Treating this cookie as durable proof a factor was shown.** That is
//    `sessionState.ts`'s concern, not this module's, and it is already fixed
//    there: `mfa_source = 'dispositivo'` is deliberately excluded from the
//    evidence `estadoEfectivo`'s third clause accepts as permanent, because
//    unlike the other three sources it is written without anybody proving
//    anything at the moment it is written.
//
// If Isaias wants either of those two, they are added on purpose; neither
// comes free with "remember this device".
//
// ---
//
// **A known gap, written down rather than hidden.** The design spec (§3)
// says a login that enters through this cookie should leave the new session
// row with `mfa_source = 'dispositivo'` (and `mfa_satisfied_at` left NULL —
// see that section for why setting it too would be its own hole). Writing
// that column requires `sessionStore.ts`'s `createSession` to accept it,
// and neither that file nor `auth/issueSession.ts` is one this task owns —
// changing them needs a caller to stop and say so rather than touch a file
// that is not theirs, which is what this comment is doing. Left unset, the
// column reads as NULL, which `estadoEfectivo`'s clause 3 already treats
// exactly like `'dispositivo'` — neither counts as evidence, so no security
// property depends on the column actually being written. What is lost is
// observability only: nothing today can tell, from the session row alone,
// that a particular login skipped its factor this way. Worth a small,
// additive follow-up (an optional field on `createSession`); not a defect
// this task can fix without touching files outside its assignment.

import type { Request, Response, CookieOptions } from "express";
import { Op } from "sequelize";
import { DispositivoRecordadoModel } from "../models/dispositivoRecordado.model.js";
import { newOpaqueToken, hashOpaqueToken } from "./opaqueToken.js";
import {
  REMEMBERED_DEVICE_COOKIE_NAME,
  REMEMBERED_DEVICE_TTL_DAYS,
  SESSION_COOKIE_SECURE,
} from "../config/security.js";

const DAY_MS = 86_400_000;

/**
 * The attributes of the remembered-device cookie, in one place so minting and
 * reading cannot disagree — the same discipline `sessionCookie.ts` follows for
 * the session cookie itself.
 *
 * Three deliberate differences from that cookie, all from the plan's own
 * wording for this task:
 *
 * - `sameSite: "strict"`, not `"lax"`. The session cookie has to survive a
 *   top-level navigation arriving from another site (a bookmark, a link in an
 *   email) or every such visit would look logged out. This cookie has no such
 *   requirement — it is only ever read on a same-site login form post — so
 *   there is no reason to relax it, and `Strict` is the tighter default for a
 *   cookie whose only job is skipping a security control.
 * - `path`, scoped to the one route that ever reads or mints this cookie
 *   rather than `"/"`. It is useless everywhere else in the ERP and has no
 *   business travelling on every image request and API call the way the
 *   session cookie must. Scoped this narrowly, it is also why this cookie
 *   could never carry a `__Host-` prefix (`REMEMBERED_DEVICE_COOKIE_NAME`'s
 *   own comment): that prefix demands `path=/`.
 * - No `domain`, for the same reason `sessionCookie.ts` has none: this API's
 *   own host is where the cookie is set and read, and adding one would only
 *   let a subdomain shadow it.
 */
const REMEMBERED_DEVICE_PATH = "/api/auth/login";

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "strict",
    path: REMEMBERED_DEVICE_PATH,
  };
}

/**
 * Hand the browser a fresh "remember this device" cookie, good for
 * `REMEMBERED_DEVICE_TTL_DAYS`. The cookie's own expiry and the row's
 * `expires_at` are computed from the same constant so the two cannot drift
 * apart — a cookie that outlived its row would fail every check silently; one
 * that expired first would just ask again a little early.
 */
export function setRememberedDeviceCookie(res: Response, token: string): void {
  res.cookie(REMEMBERED_DEVICE_COOKIE_NAME, token, {
    ...cookieOptions(),
    expires: new Date(Date.now() + REMEMBERED_DEVICE_TTL_DAYS * DAY_MS),
  });
}

/**
 * The remembered-device token the browser sent, if it sent one.
 *
 * The same `typeof` guard `sessionCookie.ts`'s `readSessionCookie` carries,
 * and for the identical reason: `cookie-parser` runs `JSONCookies` on every
 * request regardless of secret, so a raw value starting with `j:` arrives
 * here already parsed into whatever JSON it named — a number, an object,
 * anything but the string this function promises. Passing that on to
 * `hashOpaqueToken` (which demands a string or Buffer) would throw, turning a
 * malformed cookie into a 500 instead of simply being treated as "no cookie
 * sent".
 */
export function readRememberedDeviceCookie(req: Request): string | undefined {
  const value = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[
    REMEMBERED_DEVICE_COOKIE_NAME
  ];
  return typeof value === "string" ? value : undefined;
}

/**
 * `dispositivo_recordado.user_agent` and `.ip_address` widths
 * (`dispositivoRecordado.model.ts`), copied rather than imported: the model
 * itself declares them as literals (`STRING(255)`, `STRING(45)`) instead of
 * reading them from `config/security.ts`, so there is no shared constant to
 * reuse without inventing one the model does not itself use.
 */
const USER_AGENT_MAX = 255;
const IP_MAX = 45;

/**
 * `user_agent` truncated to fit the column, the same shape
 * `sessionStore.ts`'s own `fitUserAgent` uses for `sesiones` — Postgres
 * rejects an oversized `STRING` insert outright (error 22001) rather than
 * truncating it, so the cut has to happen here.
 */
function fitUserAgent(ua?: string): string | null {
  if (!ua) return null;
  return ua.slice(0, USER_AGENT_MAX);
}

/**
 * `ip_address`, first hop only. Same reasoning as `sessionStore.ts`'s
 * `fitIp`: with `trust proxy` set to one hop, `req.ip` is already a single
 * address, and this is defence in depth against that changing.
 */
function fitIp(ip?: string): string | null {
  if (!ip) return null;
  const first = ip.split(",")[0].trim();
  return first.slice(0, IP_MAX);
}

/**
 * Mint a fresh "remember this device" cookie for this account, on this
 * browser, and return the plaintext token — once, and never again. Only its
 * hash is written down, the same contract every other opaque token in this
 * arc keeps.
 *
 * `hashOpaqueToken` (SHA-256) rather than a new scheme: `token_hash` is
 * `CHAR(64)`, exactly the length of that function's hex digest, because the
 * migration that created this table decided the scheme already. Bcrypt would
 * be wrong here for the same reason it is wrong for a session token — the
 * value already carries 32 bytes of entropy, so there is nothing to stretch,
 * and this hash is looked up on every login rather than compared once.
 *
 * Deliberately does not ask whether `id_usuario` actually has a factor to
 * skip. That is a decision for the caller: `login` in `auth.controller.ts`
 * only ever calls this once a factor has already been shown (either through
 * a valid remembered device already presented, or — once the plans that
 * verify a factor exist — through a fresh proof of one). Minting on an
 * account with nothing to skip is harmless, not wrong; it is simply a row
 * `estadoInicialDeSesion` will never have a reason to read.
 */
export async function acunarDispositivo(id_usuario: number, req: Request): Promise<string> {
  const token = newOpaqueToken();
  const now = new Date();
  await DispositivoRecordadoModel.create({
    id_usuario,
    token_hash: hashOpaqueToken(token),
    user_agent: fitUserAgent(req.headers["user-agent"]),
    ip_address: fitIp(req.ip),
    created_at: now,
    expires_at: new Date(now.getTime() + REMEMBERED_DEVICE_TTL_DAYS * DAY_MS),
    revoked_at: null,
  });
  return token;
}

/**
 * Whether this token still lets `id_usuario` — and only `id_usuario` — skip
 * the second factor.
 *
 * 🔴 **The four conditions, all in the same `WHERE`, copied from
 * `revokeSessionOf`'s own shape (hallazgo C15).** `token_hash` alone is the
 * classic omission the whole arc warns about, and here it would be worse than
 * anywhere else: it is the query that decides whether a login skips its
 * second factor at all.
 *
 * - `token_hash = hash` — which cookie.
 * - `id_usuario = id_usuario` — **and whose it actually is.** Checked on the
 *   hash alone, ticking "remember me" on one account and carrying that cookie
 *   to a different login would skip *that* account's factor instead.
 * - `revoked_at IS NULL` — cut off by `logoutAll`, a password reset, an
 *   archive, or (once it exists) deleting the account's last factor.
 * - `expires_at > now()` — past its `REMEMBERED_DEVICE_TTL_DAYS`.
 *
 * **Never called before `verifyCredentials` succeeds, and that is what keeps
 * this function's job simple.** Resolving "whose device is this" before the
 * password is checked is the trap the lockout exemption (deliberately not
 * built — see this module's header) would have needed, and the only cheap way
 * to do that resolution early is to look the row up by `token_hash` alone,
 * which is exactly the omission this `WHERE` exists to refuse. Not building
 * that exemption closes the trap along with it: this function is free to
 * demand `id_usuario` because it is never asked to answer before that value
 * is known.
 */
export async function comprobarDispositivo(token: string, id_usuario: number): Promise<boolean> {
  const found = await DispositivoRecordadoModel.findOne({
    where: {
      token_hash: hashOpaqueToken(token),
      id_usuario,
      revoked_at: null,
      expires_at: { [Op.gt]: new Date() },
    },
  });
  return found !== null;
}
