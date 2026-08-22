// The migration that gives inspections and repairs an author.
//
// Tested at the same level as the other migrations here: that it asks the
// queryInterface for the right things, inside one transaction, with the delete
// rule and the window that were chosen deliberately. Two of these assertions
// exist because getting them wrong is silent — a CASCADE that deletes work
// along with an account, and a window wide enough to invent attributions —
// and neither would fail any other test in the suite.

import { describe, it, expect, vi } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260822000002-add-authorship.js";

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

/** Every call this migration makes takes its options object as the last argument. */
const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

describe("add-authorship", () => {
  it("adds id_usuario to both work tables", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toContainEqual(["revicions", "id_usuario"]);
    expect(added).toContainEqual(["solucions", "id_usuario"]);
  });

  it("leaves the author nullable", async () => {
    // 6.396 of 7.741 inspections predate the bitácora and can never be
    // attributed. NOT NULL would need a default, and a default here would name
    // some account as the author of work it did not do.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    for (const col of qi.calls.filter((c) => c.fn === "addColumn")) {
      const spec = col.args[2] as { type: unknown; allowNull: boolean };
      expect(spec.allowNull).toBe(true);
      expect(spec.type).toBe(DataTypes.INTEGER);
    }
  });

  it("keeps the work when the account goes, rather than the other way round", async () => {
    // `eventos.id_usuario` is ON DELETE CASCADE, so copying the neighbouring
    // convention would mean deleting an account takes its 846 inspections with
    // it. The inspection happened; the attribution is what is allowed to be
    // lost. Nothing else in the suite would notice this being wrong.
    //
    // It does not buy as much as it looks: `eventos.id_usuario` CASCADE plus
    // `revicions.id_evento` CASCADE still takes 6.249 of 7.741 inspections
    // when a user row is hard-deleted, whoever authored them. That chain is a
    // separate defect; this column is still right to keep its record.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    for (const col of qi.calls.filter((c) => c.fn === "addColumn")) {
      const spec = col.args[2] as { onDelete: string; references: { model: string; key: string } };
      expect(spec.onDelete).toBe("SET NULL");
      expect(spec.references).toEqual({ model: "usuarios", key: "id" });
    }
  });

  it("backfills from every action that creates one of these rows, not just the obvious one", async () => {
    // `createEvento` writes the first revision inline and logs CREATE_EVENTO;
    // `resolverEvento` writes the repair inline and logs RESOLVE_EVENTO.
    // Measured at the 2s window: ADD_REVISION alone finds 1.319 and both find
    // 1.345, so CREATE_EVENTO is worth 26 rows. On the repair side the
    // dependency runs the other way — RESOLVE_EVENTO alone finds 512 of 513,
    // and reading only the obvious CREATE_SOLUCION would have found 171.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);

    expect(sql).toMatch(/'ADD_REVISION'/);
    expect(sql).toMatch(/'CREATE_EVENTO'/);
    expect(sql).toMatch(/'CREATE_SOLUCION'/);
    expect(sql).toMatch(/'RESOLVE_EVENTO'/);
  });

  it("only attributes a row when the evidence names one person", async () => {
    // Two people writing about the same event inside the window is a coin
    // flip, and a coin flip in an authorship column is worse than a null: it
    // reads as fact. The HAVING is what makes the MIN unambiguous.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);

    expect(sql).toMatch(/HAVING\s+COUNT\(DISTINCT\s+b\."id_usuario"\)\s*=\s*1/i);
  });

  it("matches on a window measured in seconds, not tens of seconds", async () => {
    // The first version of this migration used 30 seconds and justified it by
    // measuring 30s, 1min and 5min. Measuring downwards is what mattered:
    // every width from 0.5s to 5s recovers the identical 1.345 and 513 rows
    // with zero ambiguity, and — the part that decides it — zero rows have a
    // *foreign* action inside the window, against 123 at 30 seconds. Wider
    // recovers nothing and only widens the door.
    //
    // The upper bound is asserted rather than the exact string so a later
    // adjustment inside the safe band does not have to touch this test, while
    // a slide back to tens of seconds fails it.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);

    const windows = [...sqlOf(qi).matchAll(/interval '([\d.]+) seconds?'/g)].map((m) => Number(m[1]));
    expect(windows.length).toBeGreaterThan(0);
    expect(Math.max(...windows)).toBeLessThanOrEqual(5);
    expect(sql).not.toMatch(/interval '\d+ (minute|minutes|hour|hours|day|days)'/);
  });

  it("never overwrites an author that is already there", async () => {
    // Umzug records a migration after up() resolves and outside its
    // transaction, so the work can be committed and unrecorded. The natural
    // repair is down() then up() — and by then the app has been stamping real
    // authors on new rows, which a second backfill would replace with guesses.
    // Without this clause the migration is a data-loss path with a plausible
    // trigger.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const updates = qi.calls
      .filter((c) => c.fn === "query" && /UPDATE/i.test(String(c.args[0])))
      .map((c) => String(c.args[0]));
    expect(updates.length).toBe(2);
    for (const sql of updates) {
      expect(sql).toMatch(/t\."id_usuario"\s+IS\s+NULL/i);
    }
  });

  it("indexes what the backfill joins on before it joins on it", async () => {
    // `bitacoras` had no index on entity_id, so the backfill was a sequential
    // scan of the whole audit log — twice — while holding ACCESS EXCLUSIVE on
    // the two tables the event screen reads.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const order = qi.calls.map((c, i) => ({ ...c, i }));
    const idx = order.find(
      (c) => c.fn === "addIndex" && c.args[0] === "bitacoras",
    );
    expect(idx).toBeDefined();
    expect((idx!.args[1] as string[])).toEqual(["entity_id"]);
    const firstUpdate = order.find((c) => c.fn === "query" && /UPDATE/i.test(String(c.args[0])))!.i;
    expect(idx!.i).toBeLessThan(firstUpdate);
  });

  it("bounds how long it holds the lock, not just how long it waits for it", async () => {
    // lock_timeout covers acquisition only. After the first ALTER takes ACCESS
    // EXCLUSIVE, the two UPDATEs and three CREATE INDEXes run with every read
    // of these tables queued behind them.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(sqlOf(qi)).toMatch(/statement_timeout/i);
  });

  it("does not hand the same column spec object to both ALTERs", async () => {
    // Sequelize's normalizeAttribute rewrites `attribute.type` in place rather
    // than on a copy, so a shared literal aliases the two DDL statements.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const specs = qi.calls.filter((c) => c.fn === "addColumn").map((c) => c.args[2]);
    expect(specs).toHaveLength(2);
    expect(specs[0]).not.toBe(specs[1]);
    expect(specs[0]).toEqual(specs[1]);
  });

  it("matches the row's own event, and both sides of its own timestamp", async () => {
    // A backfill joined on the event alone attributes 1.697 inspections from
    // whatever else happened to that event, years apart, and leaves 2.630
    // ambiguous. And MIN() would pick the lowest user id, not the last person
    // to touch it.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);

    expect(sql).toMatch(/b\."entity_id"\s*=\s*t\."id_evento"/);
    expect(sql).toMatch(/b\."createdAt"\s*>=\s*t\."createdAt"\s*-\s*interval/);
    expect(sql).toMatch(/b\."createdAt"\s*<=\s*t\."createdAt"\s*\+\s*interval/);
  });

  it("indexes the column it exists to group by", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const indexed = qi.calls
      .filter((c) => c.fn === "addIndex")
      .map((c) => [c.args[0], (c.args[1] as string[]).join(","), (c.args[2] as { name: string }).name]);
    expect(indexed).toContainEqual(["revicions", "id_usuario", "idx_revicions_id_usuario"]);
    expect(indexed).toContainEqual(["solucions", "id_usuario", "idx_solucions_id_usuario"]);
  });

  it("caps how long it will wait for the table lock", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(sqlOf(qi)).toMatch(/lock_timeout/i);
  });

  it("runs everything inside one transaction, and hands it to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    // A migration that opens a transaction and then makes its real calls
    // outside it passes a test that only counts the transaction() call. The
    // backfill escaping the transaction is the version of this bug that
    // matters: the column would exist with no history in it.
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);
  });

  it("adds the column before it tries to fill it", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const order = qi.calls.map((c, i) => ({ ...c, i }));
    const lastAdd = order.filter((c) => c.fn === "addColumn").at(-1)!.i;
    const firstUpdate = order.find((c) => c.fn === "query" && /UPDATE/i.test(String(c.args[0])))!.i;
    expect(firstUpdate).toBeGreaterThan(lastAdd);
  });

  it("can be undone: indexes and columns gone, in the opposite order, in a transaction", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await down({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);

    const order = qi.calls
      .filter((c) => c.fn === "removeIndex" || c.fn === "removeColumn")
      .map((c) => `${c.fn}:${c.args[0]}`);
    expect(order).toEqual([
      "removeIndex:solucions",
      "removeIndex:revicions",
      "removeIndex:bitacoras",
      "removeColumn:solucions",
      "removeColumn:revicions",
    ]);
  });

  it("caps the lock wait when rolling back too", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    expect(sqlOf(qi)).toMatch(/lock_timeout/i);
  });

  it("does not touch any table but the two it is about", async () => {
    // A backfill is an UPDATE written by hand; the guard is cheap and the
    // failure mode is not.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const updated = sqlOf(qi).match(/UPDATE\s+"(\w+)"/gi) ?? [];
    expect(new Set(updated.map((m) => m.replace(/UPDATE\s+"/i, "").replace('"', ""))))
      .toEqual(new Set(["revicions", "solucions"]));
  });
});
