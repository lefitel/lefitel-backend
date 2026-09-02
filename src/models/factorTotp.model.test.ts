// Hallazgo B10, confirmed by actually running `toJSON` on a real instance —
// not by reading `defaultScope` off the model's options, which proves only
// that a bare query is guarded and says nothing about what `JSON.stringify`
// or `res.json(...)` would do with a row that already made it into memory
// through an `include`.
//
// Why this one matters more than the other three: the ciphertext leaking
// once is enough to recover the TOTP secret retroactively the day
// `MFA_ENCRYPTION_KEY` is ever compromised, and this row is never rotated on
// its own — today's ciphertext is still today's ciphertext three years from
// now.

import { describe, it, expect } from "vitest";
import { FactorTotpModel } from "./factorTotp.model.js";

function unFactor() {
  return FactorTotpModel.build({
    id: 1,
    id_usuario: 7,
    secreto_cifrado: Buffer.from("criptograma-real"),
    iv: Buffer.from("iv-real-12b."),
    auth_tag: Buffer.from("auth-tag-real-16"),
    key_version: 1,
    ultimo_paso: null,
    confirmed_at: new Date("2026-01-01T00:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
  } as never);
}

describe("FactorTotpModel.toJSON", () => {
  it("never serialises the ciphertext, the iv or the tag", () => {
    const factor = unFactor();
    const serializado = JSON.stringify(factor.toJSON());

    expect(serializado).not.toContain("criptograma-real");
    expect(serializado).not.toContain("iv-real-12b");
    expect(serializado).not.toContain("auth-tag-real-16");

    const salida = JSON.parse(serializado);
    expect(salida).not.toHaveProperty("secreto_cifrado");
    expect(salida).not.toHaveProperty("iv");
    expect(salida).not.toHaveProperty("auth_tag");
  });

  it("still serialises everything that is not the secret, so this is not over-redacting", () => {
    const salida = unFactor().toJSON() as unknown as Record<string, unknown>;
    expect(salida.id).toBe(1);
    expect(salida.id_usuario).toBe(7);
    expect(salida.key_version).toBe(1);
    expect(salida.confirmed_at).toBeInstanceOf(Date);
  });
});
