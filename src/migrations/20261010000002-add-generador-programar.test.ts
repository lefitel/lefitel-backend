// The one cell this migration adds. What it writes was checked against a real
// PostgreSQL; here is what must stay true of the statement itself.

import { describe, it, expect } from "vitest";
import { up, down } from "./20261010000002-add-generador-programar.js";
import { ACTION_LABELS, PERMISSIONS, isActionOf } from "../permissions/matrix.js";

function fakeQueryInterface() {
  const calls: { sql: string; opciones: { replacements?: Record<string, unknown>; transaction?: unknown } }[] = [];
  return {
    calls,
    sequelize: {
      query: (sql: string, opciones: { replacements?: Record<string, unknown>; transaction?: unknown } = {}) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), opciones });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

describe("add-generador-programar", () => {
  it("writes one row per role that exists, granted to the Administrador and to nobody else", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const insert = qi.calls.find((c) => c.sql.startsWith("INSERT INTO permisos"));
    expect(insert?.sql).toContain("SELECT r.id, :modulo, :accion, (r.id = :admin), now(), now() FROM rols r");
    expect(insert?.opciones.replacements).toEqual({ modulo: "generador", accion: "programar", admin: 1 });
  });

  it("overwrites nothing that is already there", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls.find((c) => c.sql.startsWith("INSERT"))?.sql).toContain(
      "ON CONFLICT (id_rol, modulo, accion) DO NOTHING",
    );
  });

  it("removes exactly that cell on the way down, and no other", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const borrado = qi.calls.find((c) => c.sql.startsWith("DELETE"));
    expect(borrado?.sql).toBe("DELETE FROM permisos WHERE modulo = :modulo AND accion = :accion");
    expect(borrado?.opciones.replacements).toEqual({ modulo: "generador", accion: "programar" });
  });

  it("runs inside one transaction with the lock timeout first, both ways", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(qi.calls[0].sql).toContain("lock_timeout");
      for (const c of qi.calls) expect(c.opciones.transaction).toEqual({ id: "t" });
    }
  });
});

describe("the pair it seeds", () => {
  it("is one the vocabulary declares — a seeded row nothing can read would be granted and invisible", () => {
    expect(isActionOf("generador", "programar")).toBe(true);
    expect(PERMISSIONS.generador).toContain("programar");
  });

  it("belongs to the generator alone", () => {
    for (const [modulo, acciones] of Object.entries(PERMISSIONS)) {
      if (modulo === "generador") continue;
      expect(acciones as readonly string[], modulo).not.toContain("programar");
    }
  });

  it("has words for the permissions screen to show", () => {
    expect(ACTION_LABELS.programar).toBe("Programar envíos");
  });
});
