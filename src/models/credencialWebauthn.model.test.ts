// Hallazgo B10, confirmed by actually running `toJSON` on a real instance —
// not by reading `defaultScope` off the model's options, which proves only
// that a bare query is guarded and says nothing about what `JSON.stringify`
// or `res.json(...)` would do with a row that already made it into memory
// through an `include`.

import { describe, it, expect } from "vitest";
import { CredencialWebauthnModel } from "./credencialWebauthn.model.js";

describe("CredencialWebauthnModel.toJSON", () => {
  it("never serialises the public key", () => {
    const credencial = CredencialWebauthnModel.build({
      id: 1,
      id_usuario: 7,
      credential_id: "abc123",
      public_key: Buffer.from("clave-publica-real"),
      counter: 0,
      transports: "usb",
      nombre: "mi llave",
      created_at: new Date(),
      last_used_at: null,
    } as never);

    const serializado = JSON.stringify(credencial.toJSON());

    expect(serializado).not.toContain("clave-publica-real");
    expect(JSON.parse(serializado)).not.toHaveProperty("public_key");
  });

  it("still serialises everything that is not the key, so this is not over-redacting", () => {
    // A toJSON that swallowed the useful fields would be its own kind of
    // failure: a response with nothing recognisable in it is not safer than
    // one that leaks, it just makes the screen that lists someone's passkeys
    // unbuildable.
    const credencial = CredencialWebauthnModel.build({
      id: 1,
      id_usuario: 7,
      credential_id: "abc123",
      public_key: Buffer.from("x"),
      counter: 3,
      transports: "usb",
      nombre: "mi llave",
      created_at: new Date("2026-01-01T00:00:00Z"),
      last_used_at: null,
    } as never);

    const salida = credencial.toJSON() as unknown as Record<string, unknown>;
    expect(salida.id).toBe(1);
    expect(salida.credential_id).toBe("abc123");
    expect(salida.nombre).toBe("mi llave");
    expect(salida.counter).toBe(3);
  });
});
