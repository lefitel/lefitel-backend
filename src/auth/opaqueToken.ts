import { randomBytes, createHash } from "node:crypto";

// The opaque-token primitive: unguessable, and irreversible once hashed.
// Extracted out of `sessionToken.ts`, which used to be the only caller and
// whose name is what made that a problem — a password-reset module has no
// business importing something called a "session token". `sessionToken.ts`
// still exports the same two functions it always did, delegating here, so
// nothing that already calls it had to change.

/** Bytes of entropy in an opaque token. */
const TOKEN_BYTES = 32;

/**
 * A new opaque token: the value handed to whoever is meant to hold it — a
 * cookie, an email link — and never written down anywhere. Only its hash is.
 *
 * `randomBytes` and not `Math.random`, which is not a cryptographic source
 * and whose output can be predicted from previous output.
 *
 * base64url so the value never needs escaping in a cookie header or a URL
 * query string, and so nothing downstream has to guess whether a `+` was a
 * plus or a space.
 */
export function newOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * What gets written down instead of the token itself.
 *
 * SHA-256, not bcrypt: the token already carries 256 bits of entropy, so
 * there is nothing to stretch — bcrypt's cost exists to slow down guessing a
 * low-entropy secret, and a 32-byte random value is not that.
 */
export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
