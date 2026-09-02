// Hallazgo B10, confirmed by actually running `toJSON` on a real instance —
// not by reading `defaultScope` off the model's options, which proves only
// that a bare query is guarded and says nothing about what `JSON.stringify`
// or `res.json(...)` would do with a row that already made it into memory
// through an `include`.

import { describe, it, expect } from "vitest";
import { DispositivoRecordadoModel } from "./dispositivoRecordado.model.js";

describe("DispositivoRecordadoModel.toJSON", () => {
  it("never serialises the remembered device token hash", () => {
    const dispositivo = DispositivoRecordadoModel.build({
      id: "11111111-1111-1111-1111-111111111111",
      id_usuario: 7,
      token_hash: "a".repeat(64),
      user_agent: "Mozilla/5.0",
      ip_address: "127.0.0.1",
      created_at: new Date("2026-01-01T00:00:00Z"),
      expires_at: new Date("2026-01-31T00:00:00Z"),
      revoked_at: null,
    } as never);

    const serializado = JSON.stringify(dispositivo.toJSON());

    expect(serializado).not.toContain("a".repeat(64));
    expect(JSON.parse(serializado)).not.toHaveProperty("token_hash");
  });

  it("still serialises everything that is not the hash, so this is not over-redacting", () => {
    const salida = DispositivoRecordadoModel.build({
      id: "11111111-1111-1111-1111-111111111111",
      id_usuario: 7,
      token_hash: "a".repeat(64),
      user_agent: "Mozilla/5.0",
      ip_address: "127.0.0.1",
      created_at: new Date("2026-01-01T00:00:00Z"),
      expires_at: new Date("2026-01-31T00:00:00Z"),
      revoked_at: null,
    } as never).toJSON() as unknown as Record<string, unknown>;

    expect(salida.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(salida.id_usuario).toBe(7);
    expect(salida.user_agent).toBe("Mozilla/5.0");
  });
});
