// The one migration Plan 4B needs. Hallazgo B7: checking a recovery code by
// pulling the ten outstanding rows and looping `bcryptjs.compare` over each
// one stops the server for 2.6 seconds per attempt (88% event-loop
// starvation, measured) — a denial of service that costs the attacker
// nothing but a wrong password. `prefijo` turns that into an index lookup:
// at most one candidate row, one `compare`.
//
// What is pinned here is the shape the fix depends on: the column is
// `CHAR(8)` and `NOT NULL` with no default (there are zero rows to migrate),
// the index is composite on `(id_usuario, prefijo)` rather than two separate
// single-column indexes, and both directions carry the transaction and the
// lock timeout the rest of this arc's migrations use.

import { describe, it, expect, vi } from "vitest";
import { up, down } from "./20260902000001-recovery-code-prefix.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    addColumn: record("addColumn"),
    removeColumn: record("removeColumn"),
    addIndex: record("addIndex"),
    removeIndex: record("removeIndex"),
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const queriesOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

async function ran(direccion: typeof up | typeof down) {
  const qi = fakeQueryInterface();
  await direccion({ context: qi as never });
  return qi;
}

describe("recovery-code-prefix", () => {
  it("adds prefijo to codigo_recuperacion", async () => {
    const qi = await ran(up);

    const col = qi.calls.find((c) => c.fn === "addColumn");
    expect(col?.args[0]).toBe("codigo_recuperacion");
    expect(col?.args[1]).toBe("prefijo");
  });

  it("is an 8-character fixed column, NOT NULL — no default, because there are zero rows to migrate", async () => {
    const qi = await ran(up);

    const col = qi.calls.find((c) => c.fn === "addColumn");
    const spec = col?.args[2] as { type: unknown; allowNull: boolean; defaultValue?: unknown };
    expect(String(spec.type)).toBe("CHAR(8)");
    expect(spec.allowNull).toBe(false);
    expect(spec.defaultValue).toBeUndefined();
  });

  it("indexes (id_usuario, prefijo) together, not as two separate single-column indexes", async () => {
    // Every lookup this column exists for filters by both columns at once.
    // Two separate indexes would make Postgres intersect two bitmaps for a
    // query this composite index already answers in one pass.
    const qi = await ran(up);

    const indice = qi.calls.find((c) => c.fn === "addIndex");
    expect(indice?.args[0]).toBe("codigo_recuperacion");
    const opciones = indice?.args[1] as { fields: string[]; name?: string };
    expect(opciones.fields).toEqual(["id_usuario", "prefijo"]);
    expect(opciones.name).toBe("codigo_recuperacion_id_usuario_prefijo_idx");
  });

  it("adds the column before the index that depends on it existing", async () => {
    const qi = await ran(up);

    const columna = qi.calls.findIndex((c) => c.fn === "addColumn");
    const indice = qi.calls.findIndex((c) => c.fn === "addIndex");
    expect(columna).toBeGreaterThanOrEqual(0);
    expect(indice).toBeGreaterThan(columna);
  });

  it("takes the lock timeout first, before touching the table", async () => {
    const qi = await ran(up);

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });

  it("touches no table other than codigo_recuperacion", async () => {
    const qi = await ran(up);

    for (const call of qi.calls) {
      if (call.fn === "addColumn" || call.fn === "addIndex") {
        expect(call.args[0], `${call.fn} sobre una tabla inesperada`).toBe("codigo_recuperacion");
      }
    }
  });

  it("runs everything inside one transaction, and hands that transaction to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn} sin transacción`).toBeDefined();
    }
  });

  it("reverses cleanly: drops the index, then the column, in one transaction", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await down({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn} sin transacción en down()`).toBeDefined();
    }

    const orden = qi.calls
      .filter((c) => c.fn === "removeIndex" || c.fn === "removeColumn")
      .map((c) => c.fn);
    expect(orden).toEqual(["removeIndex", "removeColumn"]);

    const indice = qi.calls.find((c) => c.fn === "removeIndex");
    expect(indice?.args).toEqual(
      expect.arrayContaining(["codigo_recuperacion", "codigo_recuperacion_id_usuario_prefijo_idx"]),
    );
    const columna = qi.calls.find((c) => c.fn === "removeColumn");
    expect(columna?.args[0]).toBe("codigo_recuperacion");
    expect(columna?.args[1]).toBe("prefijo");
  });

  it("caps the wait for the table lock when rolling back too", async () => {
    const qi = await ran(down);

    expect(queriesOf(qi)).toMatch(/lock_timeout/i);
  });
});
