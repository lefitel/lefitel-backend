// The MFA keyring: which encryption keys the environment configures, how a
// malformed one fails, and the one thing it must never fall back to.
//
// Every test stubs its own `MFA_ENCRYPTION_KEY_*` variables and relies on
// `afterEach`'s `vi.unstubAllEnvs()` to undo them — the same pattern
// `auth/securityNotice.test.ts` and `auth/mailer.test.ts` already use for
// `process.env`. Nothing here is mocked: `mfaKeyring.ts` reads `process.env`
// itself on every call, with no module-level cache, so stubbing a variable
// before calling a function is enough on its own.

import { afterEach, describe, expect, it, vi } from "vitest";
import { llaveActiva, llavePorVersion, versionesDisponibles } from "./mfaKeyring.js";

// Two syntactically valid AES-256 keys — 64 hex characters, 32 bytes — kept
// distinct so a test needing "a second, different key" does not have to
// invent one inline.
const CLAVE_A = "a".repeat(64);
const CLAVE_B = "b".repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("llaveActiva", () => {
  it("behaves exactly as if there were no keyring when only one key is configured", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");

    const llave = llaveActiva();
    expect(llave.version).toBe(1);
    expect(llave.clave).toEqual(Buffer.from(CLAVE_A, "hex"));
    expect(llave.clave).toHaveLength(32);
  });

  it("returns the key ACTIVE names when more than one is configured", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_2", CLAVE_B);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "2");

    const llave = llaveActiva();
    expect(llave.version).toBe(2);
    expect(llave.clave).toEqual(Buffer.from(CLAVE_B, "hex"));
  });

  it("throws when MFA_ENCRYPTION_KEY_ACTIVE is missing", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", undefined);
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_ACTIVE/);
  });

  it("throws when MFA_ENCRYPTION_KEY_ACTIVE is not a plain positive integer", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "uno");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_ACTIVE/);

    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "0");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_ACTIVE/);

    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "-1");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_ACTIVE/);
  });

  it("names the missing version and refuses to fall back to key 1 when ACTIVE points elsewhere", () => {
    // Decision from Task 1 of docs/plans/2026-09-01-factores-mfa.md: a typo
    // in _ACTIVE is a configuration error, not an invitation to keep
    // encrypting under whatever key happens to be configured as version 1.
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "7");

    // Throwing at all already proves there is no silent fallback to key 1;
    // naming MFA_ENCRYPTION_KEY_7 (not _1) proves it names the right one.
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_7/);
  });
});

describe("llavePorVersion", () => {
  it("returns a specific version's key even when it is not the active one", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_2", CLAVE_B);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "2");

    const vieja = llavePorVersion(1);
    expect(vieja.version).toBe(1);
    expect(vieja.clave).toEqual(Buffer.from(CLAVE_A, "hex"));
  });

  it("throws naming the variable when the requested version was never configured", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    expect(() => llavePorVersion(3)).toThrow(/MFA_ENCRYPTION_KEY_3/);
  });
});

describe("key validation (finding B2)", () => {
  it("rejects a 65-character hex key", () => {
    // 🔴 B2, measured: Buffer.from(x, 'hex') decodes 64 valid hex characters
    // to 32 bytes and stops there, silently dropping the 65th character.
    // Checking only the decoded buffer's length would let this exact typo
    // through as if it were a valid 32-byte key.
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", "a".repeat(65));
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_1/);
  });

  it("rejects a key one character short", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", "a".repeat(63));
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_1/);
  });

  it("rejects a key with a non-hex character even when the length is otherwise 64", () => {
    // Table from the audit (B2): a leading invalid character makes
    // Buffer.from decode 0 bytes; a trailing one decodes 31. The regex
    // rejects both before a byte count is ever computed.
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", "g" + "a".repeat(63));
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_1/);

    vi.stubEnv("MFA_ENCRYPTION_KEY_1", "a".repeat(63) + "g");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_1/);
  });

  it("rejects a key carrying a 0x prefix", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", "0x" + "a".repeat(64));
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    expect(() => llaveActiva()).toThrow(/MFA_ENCRYPTION_KEY_1/);
  });

  it("never includes the key's own value in a thrown error message", () => {
    const marcador = "MARCADOR-QUE-NO-DEBE-APARECER";
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", marcador);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");

    let mensaje = "";
    try {
      llaveActiva();
    } catch (err) {
      mensaje = (err as Error).message;
    }
    expect(mensaje).toContain("MFA_ENCRYPTION_KEY_1");
    expect(mensaje).not.toContain(marcador);
  });
});

describe("versionesDisponibles", () => {
  it("returns an empty list when no key is configured", () => {
    expect(versionesDisponibles()).toEqual([]);
  });

  it("lists every configured version, sorted, even across a gap", () => {
    // This is the shape that exists right after a completed rotation: the
    // old key (version 1) has been removed and only the new one (version 3,
    // say, after two rotations) remains. versionesDisponibles must not
    // assume the set is contiguous from 1.
    vi.stubEnv("MFA_ENCRYPTION_KEY_2", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_5", CLAVE_B);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "5");

    expect(versionesDisponibles()).toEqual([2, 5]);
  });

  it("does not mistake MFA_ENCRYPTION_KEY_ACTIVE for a numbered version", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_A);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    expect(versionesDisponibles()).toEqual([1]);
  });
});
