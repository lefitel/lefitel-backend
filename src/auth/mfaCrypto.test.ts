// Authenticated encryption for the TOTP secret. This is the one group of
// tests in the whole 4B plan where a round trip passing proves nothing on
// its own: `decipher.update()` returns the correct plaintext even with a
// forged tag or the wrong AAD, and only `decipher.final()` checks either one
// (finding B1). So most tests below deliberately break something a plain
// round trip would never notice, and require `descifrar` to throw.
//
// The 65-hex-character key rejection required by Task 1 (finding B2) lives
// in `mfaKeyring.test.ts` instead of here — that is where key validation
// actually happens; `mfaCrypto.ts` only ever calls into the keyring and
// never re-validates a key's shape itself.
//
// Same env-stubbing pattern as `mfaKeyring.test.ts`: `mfaCrypto.ts` has no
// module-level cache of its own, it only calls through to the keyring, which
// reads `process.env` fresh on every call.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cifrar, descifrar } from "./mfaCrypto.js";

const CLAVE_1 = "1".repeat(64);
const CLAVE_2 = "2".repeat(64);

function usarLlaveUnica(): void {
  vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_1);
  vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cifrar / descifrar round trip", () => {
  it("round-trips a secret through encryption and decryption", () => {
    usarLlaveUnica();
    const secreto = "JBSWY3DPEHPK3PXP"; // shape of a base32 TOTP secret
    const cifrado = cifrar(secreto, "factor:42");
    expect(descifrar(cifrado, "factor:42")).toBe(secreto);
  });

  it("produces the shapes the database CHECK constraints expect", () => {
    usarLlaveUnica();
    const cifrado = cifrar("cualquier secreto", "factor:1");
    expect(cifrado.iv).toHaveLength(12); // factor_totp_iv_len_chk
    expect(cifrado.auth_tag).toHaveLength(16); // factor_totp_tag_len_chk
    expect(cifrado.key_version).toBe(1);
  });
});

describe("B1 — the tag has to be checked, not merely produced", () => {
  it("throws when the tag has been tampered with", () => {
    usarLlaveUnica();
    const cifrado = cifrar("secreto original", "factor:1");
    // Flip one bit of the tag — a forged or corrupted tag, not a corrupted
    // ciphertext, is exactly the case `decipher.update()` alone would miss.
    const tagAlterado = Buffer.from(cifrado.auth_tag);
    tagAlterado[0] ^= 0xff;

    expect(() => descifrar({ ...cifrado, auth_tag: tagAlterado }, "factor:1")).toThrow();
  });

  it("never leaks the plaintext or the key through the error it throws on a bad tag", () => {
    usarLlaveUnica();
    const secreto = "PLAINTEXT-QUE-NO-DEBE-APARECER";
    const cifrado = cifrar(secreto, "factor:1");
    const tagAlterado = Buffer.from(cifrado.auth_tag);
    tagAlterado[0] ^= 0xff;

    let lanzo = false;
    let mensaje = "";
    try {
      descifrar({ ...cifrado, auth_tag: tagAlterado }, "factor:1");
    } catch (err) {
      lanzo = true;
      mensaje = (err as Error).message;
    }
    // Asserted explicitly, not just implied by the two checks below: without
    // this, a `descifrar` that stops throwing entirely would leave `mensaje`
    // empty and both `not.toContain` checks would pass vacuously, hiding
    // exactly the regression this test exists to catch.
    expect(lanzo).toBe(true);
    expect(mensaje).not.toContain(secreto);
    expect(mensaje).not.toContain(CLAVE_1);
  });
});

describe("B3 — the AAD is part of what is authenticated", () => {
  it("throws when decrypting with another row's AAD", () => {
    usarLlaveUnica();
    const cifrado = cifrar("secreto de la fila 7", "factor:7");
    expect(() => descifrar(cifrado, "factor:8")).toThrow();
  });

  it("succeeds when the same AAD used to encrypt is used to decrypt", () => {
    usarLlaveUnica();
    const cifrado = cifrar("secreto de la fila 7", "factor:7");
    expect(descifrar(cifrado, "factor:7")).toBe("secreto de la fila 7");
  });
});

describe("B5 — the IV is never reused", () => {
  it("uses a different IV for two encryptions of the same text", () => {
    usarLlaveUnica();
    const uno = cifrar("mismo texto", "factor:1");
    const dos = cifrar("mismo texto", "factor:1");
    expect(uno.iv.equals(dos.iv)).toBe(false);
  });

  it("uses a different IV across a much larger sample, never repeating", () => {
    usarLlaveUnica();
    const vistos = new Set<string>();
    for (let i = 0; i < 200; i++) {
      vistos.add(cifrar("x", "factor:1").iv.toString("hex"));
    }
    expect(vistos.size).toBe(200);
  });
});

describe("rotation compatibility", () => {
  it("decrypts a row using its own key_version, not whichever key is active now", () => {
    // Encrypt while key 1 is active.
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_1);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    const filaVieja = cifrar("secreto de antes de rotar", "factor:1");
    expect(filaVieja.key_version).toBe(1);

    // Rotate: key 2 becomes active, key 1's variable is still present (the
    // rotation script has not removed it yet — see Task 3).
    vi.stubEnv("MFA_ENCRYPTION_KEY_2", CLAVE_2);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "2");
    const filaNueva = cifrar("secreto de después de rotar", "factor:1");
    expect(filaNueva.key_version).toBe(2);

    // The old row still has to open correctly, under its own key_version.
    expect(descifrar(filaVieja, "factor:1")).toBe("secreto de antes de rotar");
    expect(descifrar(filaNueva, "factor:1")).toBe("secreto de después de rotar");
  });
});
