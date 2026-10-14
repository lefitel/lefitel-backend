import { describe, it, expect } from "vitest";
import { up, down } from "./20261010000006-add-tramos-permisos.js";
import { MODULES, MODULE_LABELS, PERMISSIONS, isActionOf } from "../permissions/matrix.js";

function fakeQueryInterface() {
  const calls: { sql: string; opciones: { transaction?: unknown } }[] = [];
  return {
    calls,
    sequelize: {
      query: (sql: string, opciones: { transaction?: unknown } = {}) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), opciones });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

describe("add-tramos-permisos", () => {
  it("copies, role by role, what each one holds today on ciudades", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const insert = qi.calls.find((c) => c.sql.startsWith("INSERT INTO permisos"))?.sql ?? "";
    // From the live rows, not from a snapshot of three roles: the matrix editor
    // ships in the same cut, so a custom role may already exist.
    expect(insert).toContain("FROM rols r CROSS JOIN unnest(ARRAY['ver', 'crear', 'editar', 'archivar'])");
    expect(insert).toContain("p.modulo = 'ciudades'");
    expect(insert).toContain("COALESCE(p.permitido, false)");
    expect(insert).toContain("ON CONFLICT (id_rol, modulo, accion) DO NOTHING");
  });

  it("removes the module and nothing else on the way down", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    expect(qi.calls.find((c) => c.sql.startsWith("DELETE"))?.sql).toBe("DELETE FROM permisos WHERE modulo = 'tramos'");
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

describe("the module it seeds", () => {
  it("is declared with the four verbs the migration writes", () => {
    expect(PERMISSIONS.tramos).toEqual(["ver", "crear", "editar", "archivar"]);
    for (const accion of PERMISSIONS.tramos) expect(isActionOf("tramos", accion)).toBe(true);
  });

  it("is drawn right under Ciudades, with a label", () => {
    expect(MODULES.indexOf("tramos")).toBe(MODULES.indexOf("ciudades") + 1);
    expect(MODULE_LABELS.tramos).toBe("Tramos");
  });
});
