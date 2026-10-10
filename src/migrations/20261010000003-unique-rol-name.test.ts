// The migration that lets the database refuse a second active role of the same
// name.
//
// Tested at the level the other migrations here are — what it asks of the
// queryInterface, and that every statement rides the same transaction — plus
// the one thing that is this migration's own: it looks for a clash before it
// builds, and stops with the names in its message. A unique index cannot be
// created over rows that already clash, and "could not create unique index"
// half way through a cutover tells nobody which rows.

import { describe, it, expect } from "vitest";
import { up, down } from "./20261010000003-unique-rol-name.js";

function fakeQueryInterface(repetidos: { nombre: string; veces: string }[] = []) {
  const calls: { sql: string; options: { transaction?: unknown } }[] = [];
  return {
    calls,
    sequelize: {
      query: (sql: string, options: { transaction?: unknown }) => {
        calls.push({ sql: String(sql), options });
        return Promise.resolve(/^\s*SELECT/i.test(String(sql)) ? repetidos : undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const sentencias = (qi: ReturnType<typeof fakeQueryInterface>) => qi.calls.map((c) => c.sql.replace(/\s+/g, " ").trim());

describe("unique-rol-name", () => {
  it("builds one unique index over the lower-cased name of the roles that are not archived", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const crear = sentencias(qi).filter((s) => s.startsWith("CREATE"));
    expect(crear).toEqual([
      'CREATE UNIQUE INDEX rols_nombre_activo_uniq ON rols (lower(name)) WHERE "deletedAt" IS NULL',
    ]);
  });

  it("looks for a clash before it builds, among the same rows the index will cover", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const todas = sentencias(qi);
    const busca = todas.findIndex((s) => s.startsWith("SELECT"));
    const crea = todas.findIndex((s) => s.startsWith("CREATE"));
    expect(busca).toBeGreaterThan(-1);
    expect(busca).toBeLessThan(crea);
    // Active ones only, compared without case — or it would refuse over rows
    // the index does not constrain, and miss rows it does.
    expect(todas[busca]).toContain('"deletedAt" IS NULL');
    expect(todas[busca]).toContain("GROUP BY lower(name)");
  });

  it("stops without building anything when two active roles share a name, and says which", async () => {
    const qi = fakeQueryInterface([{ nombre: "supervisor", veces: "2" }, { nombre: "auditor", veces: "3" }]);

    await expect(up({ context: qi as never })).rejects.toThrow(/«supervisor» \(2\), «auditor» \(3\)/);
    expect(sentencias(qi).some((s) => s.startsWith("CREATE"))).toBe(false);
  });

  it("runs every statement inside the one transaction, with the lock timeout first", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(sentencias(qi)[0]).toBe("SET LOCAL lock_timeout = '5s'");
    for (const call of qi.calls) expect(call.options.transaction).toEqual({ id: "t" });
  });

  it("takes the index away again, and does not mind if it is already gone", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(sentencias(qi)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "DROP INDEX IF EXISTS rols_nombre_activo_uniq",
    ]);
    for (const call of qi.calls) expect(call.options.transaction).toEqual({ id: "t" });
  });
});
