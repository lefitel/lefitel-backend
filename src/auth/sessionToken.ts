import { randomBytes, createHash } from "node:crypto";

/** Bytes of entropy in a session token. */
const TOKEN_BYTES = 32;

/**
 * A new session token: the value that travels in the cookie.
 *
 * `randomBytes` and not `Math.random`, which is not a cryptographic source and
 * whose output can be predicted from previous output.
 *
 * base64url so the value never needs escaping in a Set-Cookie header, and so
 * nothing downstream has to guess whether a `+` was a plus or a space.
 */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * What the database keeps.
 *
 * SHA-256 and not bcrypt, deliberately. bcrypt exists to make a *low-entropy*
 * secret expensive to guess; this token already has 256 bits, so there is
 * nothing to stretch — and this hash is computed on every single authenticated
 * request, where bcrypt would cost 250 ms.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
