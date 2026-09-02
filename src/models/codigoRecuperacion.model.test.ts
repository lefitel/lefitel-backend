// Hallazgo B10, confirmed by actually running `toJSON` on a real instance —
// not by reading `defaultScope` off the model's options, which proves only
// that a bare query is guarded and says nothing about what `JSON.stringify`
// or `res.json(...)` would do with a row that already made it into memory
// through an `include`.

import { describe, it, expect } from "vitest";
import { CodigoRecuperacionModel } from "./codigoRecuperacion.model.js";

describe("CodigoRecuperacionModel.toJSON", () => {
  it("never serialises the recovery code hash", () => {
    const codigo = CodigoRecuperacionModel.build({
      id: 1,
      id_usuario: 7,
      codigo_hash: "$2b$12$abcdefghijklmnopqrstuv",
      used_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
    } as never);

    const serializado = JSON.stringify(codigo.toJSON());

    expect(serializado).not.toContain("$2b$12$");
    expect(JSON.parse(serializado)).not.toHaveProperty("codigo_hash");
  });

  it("still serialises everything that is not the hash, so this is not over-redacting", () => {
    const salida = CodigoRecuperacionModel.build({
      id: 1,
      id_usuario: 7,
      codigo_hash: "$2b$12$x",
      used_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
    } as never).toJSON() as unknown as Record<string, unknown>;

    expect(salida.id).toBe(1);
    expect(salida.id_usuario).toBe(7);
    expect(salida.used_at).toBeNull();
  });
});
