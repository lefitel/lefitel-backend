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

/** Variables the process refuses to start without, by environment. */
export function requiredEnv(nodeEnv: string | undefined): string[] {
  const always = ["JWT_SECRET"];
  return nodeEnv === "production" ? [...always, "CORS_ORIGIN"] : always;
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
 * there. Computing it lazily on first use and caching the result avoids both.
 */
let rellenoCache: string | null = null;
export async function hashRelleno(): Promise<string> {
  if (!rellenoCache) {
    rellenoCache = await bcryptjs.hash(randomBytes(32).toString("hex"), BCRYPT_COST);
  }
  return rellenoCache;
}
