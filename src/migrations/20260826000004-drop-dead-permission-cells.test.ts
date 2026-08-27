// The migration that removes the permission cells no module has any more.
//
// Tested at the level the other migrations here are: that it asks the
// queryInterface for the right thing, inside a transaction every call actually
// carries.
//
// Two assertions do more than bookkeeping and are the reason this file exists.
//
// The first is that the list of dead pairs is written out literally rather than
// derived from `matrix.ts`. A migration is a record of what happened to a
// database on a day, and `20260818000001-create-permisos.ts` already says so
// about itself. If this one imported `PERMISSIONS`, then the next time a module
// gains or loses an action, re-running the history against a restored dump
// would delete a different set of rows than it deleted the first time — and
// deleting granted permissions is not the kind of drift anyone notices.
//
// The second is the direction `down()` restores in. Those eight cells sit at
// `true` for the Administrador role today, and putting that `true` back would
// be granting on the way out: nothing reads those cells, so the value carries
// no meaning worth preserving, while restoring it would hand an authority back
// to a role on the strength of a rollback nobody was watching.

import { describe, it, expect } from "vitest";
import { Op } from "sequelize";
import { up, down } from "./20260826000004-drop-dead-permission-cells.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    bulkDelete: record("bulkDelete"),
    bulkInsert: record("bulkInsert"),
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

/** The eight pairs, spelled out here too, so the test cannot drift with the code. */
const MUERTAS = [
  ["archivos", "crear"],
  ["archivos", "editar"],
  ["reportes", "crear"],
  ["reportes", "editar"],
  ["reportes", "archivar"],
  ["bitacora", "crear"],
  ["bitacora", "editar"],
  ["bitacora", "archivar"],
];

describe("drop-dead-permission-cells: up", () => {
  it("deletes from permisos, once", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const deletes = qi.calls.filter((c) => c.fn === "bulkDelete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0]).toBe("permisos");
  });

  it("names exactly the eight pairs no module has, and no others", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    // Read through `Op.or` itself: it is a Symbol, so `Object.values` cannot
    // see it and an earlier version of this test silently inspected an empty
    // object.
    const where = qi.calls.find((c) => c.fn === "bulkDelete")!.args[1] as Record<
      symbol,
      { modulo: string; accion: string }[]
    >;
    const pares = where[Op.or].map((p) => [p.modulo, p.accion]);

    expect(pares.sort()).toEqual([...MUERTAS].sort());
  });

  it("touches no cell that a module still has", async () => {
    // The failure this guards against is a typo in the list deleting a live
    // permission from every role at once — silently, since the screen would
    // simply stop offering it.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const where = qi.calls.find((c) => c.fn === "bulkDelete")!.args[1] as Record<
      symbol,
      { modulo: string; accion: string }[]
    >;
    const pares = where[Op.or];

    expect(pares.some((p) => p.modulo === "postes")).toBe(false);
    expect(pares.some((p) => p.modulo === "eventos")).toBe(false);
    expect(pares.some((p) => p.modulo === "archivos" && p.accion === "archivar")).toBe(false);
    expect(pares.some((p) => p.accion === "ver")).toBe(false);
  });

  it("runs inside a transaction that every call carries", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn} sin transacción`).toEqual({ id: "t" });
    }
  });

  it("sets a lock timeout, like every other ALTER in this folder", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const queries = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0]));
    expect(queries.join("\n")).toMatch(/SET LOCAL lock_timeout/i);
  });
});

describe("drop-dead-permission-cells: down", () => {
  // `down` is one `INSERT ... SELECT` rather than a `bulkInsert`, because the
  // rows to restore depend on which roles exist — a set the migration would
  // otherwise have to read first and then race against. Asserting on the SQL is
  // the price of that, so these read the statement rather than an argument
  // object.
  const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
    qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

  it("puts the eight pairs back for every role that has rows", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const sql = sqlOf(qi);
    expect(sql).toMatch(/INSERT INTO\s+"?permisos"?/i);
    expect(sql).toMatch(/SELECT DISTINCT/i);
    for (const [modulo, accion] of MUERTAS) {
      expect(sql, `${modulo}.${accion}`).toContain(`'${modulo}'`);
      expect(sql, `${modulo}.${accion}`).toContain(`'${accion}'`);
    }
  });

  it("restores them denied, never granted", async () => {
    // The one assertion in this file that is about safety rather than shape.
    // Role 1 holds all eight at `true` today. Restoring that on the way back
    // would hand an authority to a role during a rollback nobody is watching,
    // and the value is meaningless anyway — no code reads these cells. Undoing
    // towards "no" is the only direction that cannot surprise anybody.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const sql = sqlOf(qi);
    expect(sql).toMatch(/\bfalse\b/i);
    expect(sql).not.toMatch(/\btrue\b/i);
  });

  it("runs inside a transaction that every call carries", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn} sin transacción`).toEqual({ id: "t" });
    }
  });
});
