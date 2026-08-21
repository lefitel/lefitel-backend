// The migration that adds the lockout columns.
//
// Tested at the level the other migrations are: that it asks the queryInterface
// for the right things, inside a transaction, with the types the rest of the
// schema uses. A migration that runs half way is the failure that costs a
// night, so the transaction is the part worth pinning — and pinning it means
// checking every call actually carries it, not just that `transaction()` was
// invoked once somewhere.

import { describe, it, expect, vi } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260821000001-add-account-lockout.js";

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

describe("add-account-lockout", () => {
  it("adds both columns to usuarios", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toContainEqual(["usuarios", "failed_attempts"]);
    expect(added).toContainEqual(["usuarios", "locked_until"]);
  });

  it("gives locked_until a timezone", async () => {
    // TIMESTAMP without a zone against a server in UTC and a database in
    // Bolivia puts every lockout four hours in the past, so it never locks —
    // silently, while the test that checks locking passes locally.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "locked_until");
    expect((col?.args[2] as { type: unknown }).type).toBe(DataTypes.DATE);
  });

  it("counts failures from zero rather than from null", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "failed_attempts");
    const spec = col?.args[2] as { allowNull: boolean; defaultValue: number };
    expect(spec.allowNull).toBe(false);
    expect(spec.defaultValue).toBe(0);
  });

  it("makes usernames unique, case-insensitively, among the living, under the name down() expects", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/usuarios_user_uniq/);
    expect(sql).toMatch(/lower\("user"\)/i);
    expect(sql).toMatch(/"deletedAt" IS NULL/i);
  });

  it("caps how long it will wait for the table lock", async () => {
    // ALTER TABLE takes ACCESS EXCLUSIVE on a table read by every authenticated
    // request. Deleting this line still leaves the other tests green, so it
    // gets an assertion of its own.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");
    expect(sql).toMatch(/lock_timeout/i);
  });

  it("runs everything inside one transaction, and hands that transaction to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    // A migration that opens the transaction and then makes its real calls
    // outside of it — passing no `transaction` at all — still passes if only
    // the call count above is checked. Every recorded call has to carry it.
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);
  });

  it("can be undone: columns and index gone, in the opposite order they arrived, inside a transaction", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await down({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);

    const dropIndex = qi.calls.find((c) => c.fn === "query" && /DROP INDEX/i.test(String(c.args[0])));
    expect(dropIndex).toBeDefined();
    expect(String(dropIndex?.args[0])).toMatch(/usuarios_user_uniq/);

    // A down() that forgets DROP INDEX still passes a test that only checks
    // removeColumn, and leaves usuarios_user_uniq behind — so the next up()
    // dies on "relation already exists": the same crash-loop the transaction
    // exists to prevent, through the other door.
    const order = qi.calls
      .filter((c) => (c.fn === "query" && /DROP INDEX/i.test(String(c.args[0]))) || c.fn === "removeColumn")
      .map((c) => (c.fn === "removeColumn" ? c.args[1] : "index"));
    expect(order).toEqual(["index", "locked_until", "failed_attempts"]);
  });

  it("caps the wait for the table lock when rolling back too", async () => {
    // A rollback tends to happen exactly when something is already wrong, and
    // ACCESS EXCLUSIVE from a DROP INDEX or ALTER TABLE queues every request
    // behind it just the same as up() does.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const sql = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");
    expect(sql).toMatch(/lock_timeout/i);
  });
});
