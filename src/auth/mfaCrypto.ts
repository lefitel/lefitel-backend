// Authenticated encryption for the TOTP secret: AES-256-GCM, keyed through
// `auth/mfaKeyring.ts`. See that file for why key lookup is lazy and
// uncached, and Decision 3 of `docs/plans/2026-09-01-factores-mfa.md` for the
// keyring's shape (`_1`, `_2`, … and `_ACTIVE`).
//
// **The write rule every caller has to follow, written here because this is
// the file whose output breaks if it is not:** `ciphertext`, `iv`,
// `auth_tag` and `key_version` are four separate columns on `factor_totp`
// (`auth/totpStore.ts`, Task 4), and Postgres has no idea the four of them
// have to move together. An `UPDATE` that touches two of the four — say,
// refreshing `ciphertext` and `auth_tag` while leaving the *old* `iv` in
// place because "the nonce is already stored" — is perfectly legal SQL and
// produces a row GCM can no longer open, or worse, one that opens under
// bytes reused from a previous encryption. That "worse" is finding B5,
// demonstrated: two ciphertexts under the same (key, IV) leak the GHASH
// subkey, which is enough to forge a valid tag for *someone else's* AAD.
// Every write of these four values — every `INSERT`, every `UPDATE` — has to
// happen in the same statement, always, with no exception anywhere this
// module's output is stored.
//
// Decision 6 of the same plan ties `aad` to `factor_totp.id`, never to
// `id_usuario` (that FK cascades on update; the row's own id does not). This
// module does not compute `aad` — it only requires whoever calls `descifrar`
// to pass the exact same one that was passed to the `cifrar` call that
// produced the row, for the entire life of that row.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MFA_AUTH_TAG_BYTES, MFA_IV_BYTES } from "../config/security.js";
import { llaveActiva, llavePorVersion } from "./mfaKeyring.js";

const ALGORITMO = "aes-256-gcm";

/** What `cifrar` produces and `descifrar` consumes — the four values that
 *  have to be written, and read back, together. See the module comment. */
export interface Cifrado {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
}

/**
 * Encrypt `texto`, authenticated against `aad` and nothing else. Always uses
 * the active key (`mfaKeyring.ts`'s `llaveActiva`) — there is no parameter to
 * pick a different one, because the only caller that should ever write under
 * an old key is the resumable rotation in `src/scripts/rotateMfaKey.ts`
 * (Task 3), and that script re-encrypts through this same function after
 * `MFA_ENCRYPTION_KEY_ACTIVE` has already moved.
 *
 * **A fresh IV on every single call, `randomBytes(MFA_IV_BYTES)`, with no
 * exception anywhere in this module.** See the header comment and finding
 * B5: reusing an IV under the same key is not a degradation, it is a break —
 * it hands over the GHASH subkey and, with it, the ability to forge a valid
 * tag for a different row's AAD entirely. There is no code path here that
 * re-encrypts by reusing a stored IV; `mfaCrypto.test.ts`'s "different IV"
 * test is what has to catch it if one is ever added.
 */
export function cifrar(texto: string, aad: string): Cifrado {
  const llave = llaveActiva();
  const iv = randomBytes(MFA_IV_BYTES);
  const cipher = createCipheriv(ALGORITMO, llave.clave, iv, { authTagLength: MFA_AUTH_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return { ciphertext, iv, auth_tag: cipher.getAuthTag(), key_version: llave.version };
}

/**
 * Decrypt and authenticate `c`, using the key its own `key_version` names
 * (`mfaKeyring.ts`'s `llavePorVersion`) — never the currently active one, so
 * a row written under an old key still reads correctly after a rotation
 * moves `_ACTIVE` forward. Throws if the tag, the AAD or the ciphertext do
 * not all match what one single `cifrar` call produced together.
 *
 * 🔴 **THE TRAP, in full, because a future edit "optimising" this function
 * is precisely the failure finding B1 reproduced by executing it:**
 * `decipher.update()` returns the correct plaintext **even when `auth_tag`
 * has been tampered with, or `aad` does not match the one used to encrypt,
 * or both.** Node's GCM implementation only checks the authentication tag
 * inside `decipher.final()` — a `descifrar` written as
 * `return decipher.update(c.ciphertext).toString("utf8")` compiles, passes
 * every round-trip test that only checks the plaintext comes back correct,
 * and authenticates *nothing at all*: someone who can flip bits in
 * `ciphertext`, or splice one row's `auth_tag` onto another row's bytes,
 * gets a plaintext back and no error, ever. Calling `final()` and folding
 * its output into what is returned is the one line in this entire module
 * that is the difference between "encrypted" and merely "encoded". Do not
 * remove it, do not shortcut it, and do not let anyone convince you the
 * round-trip test passing is proof this line is unnecessary — that is
 * exactly the test it does not fail.
 */
export function descifrar(c: Cifrado, aad: string): string {
  const llave = llavePorVersion(c.key_version);
  const decipher = createDecipheriv(ALGORITMO, llave.clave, c.iv, {
    authTagLength: MFA_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(c.auth_tag);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  // `final()` is what actually verifies `auth_tag` against `ciphertext` and
  // `aad` together — see the trap above. It throws on any mismatch, and its
  // output is concatenated onto `update()`'s rather than discarded, so a
  // caller that only checks the return value still gets the verified bytes,
  // not merely the first ones GCM happened to decrypt before checking.
  const texto = Buffer.concat([decipher.update(c.ciphertext), decipher.final()]);
  return texto.toString("utf8");
}
