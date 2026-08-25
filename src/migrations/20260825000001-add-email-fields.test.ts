// The migration that adds the verified-email columns.
//
// Tested at the level the other migrations are: that it asks the
// queryInterface for the right things, inside a transaction, with the types
// and the constraints the rest of the schema uses. A migration that runs
// half way is the failure that costs a night, so the transaction is the part
// worth pinning — and pinning it means checking every call actually carries
// it, not just that `transaction()` was invoked once somewhere.
//
// One test below pins a deliberate omission: this migration does NOT repeat
// `usuarios_user_uniq`, even though the design spec's SQL block lists it,
// because it already exists from 20260821000001-add-account-lockout.ts. That
// omission is easy for a future edit to "fix" by accident, so it gets its own
// assertion rather than being left to fall out of the others.

import { describe, it, expect, vi } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260825000001-add-email-fields.js";

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

/** Every `sequelize.query` call this migration made, concatenated. */
const queriesOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

describe("add-email-fields", () => {
  it("adds both columns to usuarios", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toContainEqual(["usuarios", "email"]);
    expect(added).toContainEqual(["usuarios", "email_verified_at"]);
  });

  it("makes email a nullable VARCHAR(255), matching the design spec's DDL", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "email");
    const spec = col?.args[2] as { type: unknown; allowNull: boolean };
    expect(String(spec.type)).toBe("VARCHAR(255)");
    expect(spec.allowNull).toBe(true);
  });

  it("gives email_verified_at a timezone", async () => {
    // TIMESTAMP without a zone against a server in UTC and a database in
    // Bolivia puts every verification four hours out — the same bug the
    // account-lockout migration's note on locked_until exists to avoid.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "email_verified_at");
    expect((col?.args[2] as { type: unknown }).type).toBe(DataTypes.DATE);
  });

  it("email_verified_at is nullable: an address is unverified by default", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "email_verified_at");
    expect((col?.args[2] as { allowNull: boolean }).allowNull).toBe(true);
  });

  it("creates a partial unique index on lower(email), gated on verified and alive", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/usuarios_email_verificado_uniq/);
    expect(sql).toMatch(/lower\(email\)/i);
    expect(sql).toMatch(/email_verified_at IS NOT NULL/i);
    expect(sql).toMatch(/"deletedAt" IS NULL/i);
  });

  it("does NOT repeat usuarios_user_uniq: it already exists from add-account-lockout", async () => {
    // The design spec's SQL block lists this CREATE UNIQUE INDEX again. It is
    // not a second index with the same effect — it is the exact same index
    // name, already created by 20260821000001-add-account-lockout.ts and
    // already applied to this database. Recreating it here would fail on
    // "relation already exists" inside this migration's single transaction
    // and take the two new columns above down with it.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    expect(sql).not.toMatch(/usuarios_user_uniq/);
  });

  it("caps how long it will wait for the table lock", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(queriesOf(qi)).toMatch(/lock_timeout/i);
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

  it("can be undone: index and columns gone, in the opposite order they arrived, inside a transaction", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await down({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);

    const dropIndex = qi.calls.find((c) => c.fn === "query" && /DROP INDEX/i.test(String(c.args[0])));
    expect(dropIndex).toBeDefined();
    expect(String(dropIndex?.args[0])).toMatch(/usuarios_email_verificado_uniq/);

    // A down() that forgets DROP INDEX still passes a test that only checks
    // removeColumn, and leaves usuarios_email_verificado_uniq behind — so the
    // next up() dies on "relation already exists": the same crash-loop the
    // transaction exists to prevent, through the other door.
    const order = qi.calls
      .filter((c) => (c.fn === "query" && /DROP INDEX/i.test(String(c.args[0]))) || c.fn === "removeColumn")
      .map((c) => (c.fn === "removeColumn" ? c.args[1] : "index"));
    expect(order).toEqual(["index", "email_verified_at", "email"]);
  });

  it("caps the wait for the table lock when rolling back too", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(queriesOf(qi)).toMatch(/lock_timeout/i);
  });
});
