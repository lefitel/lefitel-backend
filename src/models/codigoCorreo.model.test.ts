// Hallazgo B10, confirmed by actually running `toJSON` on a real instance —
// not by reading `defaultScope` off the model's options. And the check
// `factorModels.test.ts` runs for the four factor tables, repeated here for the
// fifth: the model declares exactly the columns its migration creates.

import { describe, it, expect } from "vitest";
import { CodigoCorreoModel } from "./codigoCorreo.model.js";
import { up } from "../migrations/20260903000001-create-codigo-correo.js";

function filaDeEjemplo() {
  return CodigoCorreoModel.build({
    id: 1,
    id_usuario: 7,
    email_destino: "isaias@example.com",
    codigo_hash: "$2b$12$abcdefghijklmnopqrstuv",
    intentos: 2,
    expires_at: new Date("2026-01-01T00:10:00Z"),
    used_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
  } as never);
}

describe("CodigoCorreoModel.toJSON", () => {
  it("never serialises the code hash", () => {
    const serializado = JSON.stringify(filaDeEjemplo().toJSON());
    expect(serializado).not.toContain("$2b$12$");
    expect(JSON.parse(serializado)).not.toHaveProperty("codigo_hash");
  });

  it("still serialises everything that is not the hash, so this is not over-redacting", () => {
    const salida = filaDeEjemplo().toJSON() as unknown as Record<string, unknown>;
    expect(salida.id).toBe(1);
    expect(salida.id_usuario).toBe(7);
    expect(salida.email_destino).toBe("isaias@example.com");
    expect(salida.intentos).toBe(2);
    expect(salida.used_at).toBeNull();
  });

  it("excludes the hash from a bare read through the default scope — the real injection, not the options object", () => {
    // `_injectScope` is what `findOne`/`findAll` run before building the
    // query (`model.js`, `_validateIncludedElement` and `findAll`); asking it
    // directly proves the scope is honoured without a database. Reading
    // `options.defaultScope` would only prove the object is shaped right.
    const opciones: { attributes?: { exclude?: string[] } } = {};
    (CodigoCorreoModel as unknown as { _injectScope(o: unknown): void })._injectScope(opciones);
    expect(opciones.attributes?.exclude).toEqual(["codigo_hash"]);
  });
});

describe("CodigoCorreoModel and its migration agree", () => {
  it("names the table the migration creates, with Sequelize's timestamps off", () => {
    expect(CodigoCorreoModel.getTableName()).toBe("codigo_correo");
    expect(CodigoCorreoModel.options.timestamps).toBe(false);
  });

  it("declares exactly the columns createTable gets — no more, no fewer", async () => {
    const creadas: Record<string, unknown>[] = [];
    const qi = {
      createTable: (_tabla: string, columnas: Record<string, unknown>) => {
        creadas.push(columnas);
        return Promise.resolve();
      },
      addIndex: () => Promise.resolve(),
      sequelize: {
        query: () => Promise.resolve(),
        literal: (sql: string) => sql,
        transaction: (cb: (t: unknown) => Promise<void>) => cb({}),
      },
    };
    await up({ context: qi as never });

    expect(creadas).toHaveLength(1);
    expect(Object.keys(CodigoCorreoModel.getAttributes()).sort()).toEqual(Object.keys(creadas[0]).sort());
  });
});
