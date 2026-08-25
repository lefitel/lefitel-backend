import { newOpaqueToken, hashOpaqueToken } from "./opaqueToken.js";

/**
 * A new session token: the value that travels in the cookie.
 *
 * Delegates to the shared opaque-token primitive (`opaqueToken.ts`), which
 * carries the reasoning about entropy and encoding — 32 random bytes,
 * base64url. This function keeps its own name and signature so that nothing
 * already calling `newSessionToken` had to change when the primitive moved
 * out into a module a password-reset flow could import without pretending
 * to want a "session token".
 */
export function newSessionToken(): string {
  return newOpaqueToken();
}

/**
 * What the database keeps.
 *
 * SHA-256 and not bcrypt, deliberately. bcrypt exists to make a *low-entropy*
 * secret expensive to guess; this token already has 256 bits, so there is
 * nothing to stretch — and this hash is computed on every single authenticated
 * request, where bcrypt would cost 250 ms.
 *
 * Delegates to `hashOpaqueToken` for the same reason as above. The bcrypt-cost
 * reasoning stays here rather than moving with the code: it is about sessions
 * specifically — a hash checked on every request — not about opaque tokens in
 * general, and `opaqueToken.ts` has its own callers (password-reset and
 * email-verification tokens) that are checked once, not on every request.
 */
export function hashSessionToken(token: string): string {
  return hashOpaqueToken(token);
}
