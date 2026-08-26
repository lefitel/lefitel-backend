// The migration that gives `rols` a soft delete.
//
// Tested at the level the other migrations here are: that it asks the
// queryInterface for the right thing, with the right type, inside a
// transaction that every call actually carries — a migration that runs half
// way is the failure that costs a night.
//
// The column's whole purpose is to stop `RolModel.destroy()` being a real
// DELETE against a table that `usuarios.id_rol` cascades from. So the type
// assertion below is not bookkeeping: Sequelize decides `destroy()` is a soft
// delete by looking for this exact attribute name, and a column added under any
// other name would leave the cascade live while looking fixed.

import { describe, it, expect } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260826000001-add-rol-archiving.js";

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
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

/** Every call this migration makes takes its options object as the last argument. */
const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const queriesOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

describe("add-rol-archiving", () => {
  it("adds deletedAt to rols", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toEqual([["rols", "deletedAt"]]);
  });

  it("names the column exactly deletedAt, which is what makes destroy() soft", async () => {
    // Sequelize looks for this attribute to decide whether `paranoid: true`
    // has anything to write to. `deleted_at`, `archivedAt` or any other name
    // leaves `RolModel.destroy()` issuing a real DELETE — and `usuarios.id_rol`
    // is ON DELETE CASCADE, so that DELETE takes the accounts with it.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn");
    expect(col?.args[1]).toBe("deletedAt");
  });

  it("gives deletedAt a timezone, like every other deletedAt in this schema", async () => {
    // TIMESTAMP without a zone against a server in UTC and a database in
    // Bolivia archives things four hours out — the bug the account-lockout
    // migration's note on locked_until exists to avoid.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn");
    expect((col?.args[2] as { type: unknown }).type).toBe(DataTypes.DATE);
  });

  it("makes it nullable: null is what 'not archived' means", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn");
    expect((col?.args[2] as { allowNull: boolean }).allowNull).toBe(true);
  });

  it("sets a lock timeout, the house rule for every ALTER TABLE here", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(queriesOf(qi)).toMatch(/SET LOCAL lock_timeout = '5s'/);
  });

  it("carries the transaction on every call, not just on the first", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(1);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn} sin transacción`).toEqual({ id: "t" });
    }
  });

  it("removes the column on the way down, inside its own transaction", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const removed = qi.calls.filter((c) => c.fn === "removeColumn").map((c) => [c.args[0], c.args[1]]);
    expect(removed).toEqual([["rols", "deletedAt"]]);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn} sin transacción`).toEqual({ id: "t" });
    }
  });

  it("does not touch usuarios: the cascade is closed in the model and the controller", async () => {
    // Worth pinning because the tempting "real" fix is to drop the CASCADE on
    // `usuarios.id_rol`. That is a change to a constraint seventeen keys deep
    // in a chain nothing else in this migration understands, and it would still
    // leave `DELETE /api/rol/:id` erasing the role and its permission matrix.
    // Soft-deleting the role is what makes the cascade unreachable, and it is
    // reversible.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const tables = qi.calls
      .filter((c) => c.fn === "addColumn" || c.fn === "removeColumn")
      .map((c) => c.args[0]);
    expect(tables).not.toContain("usuarios");
  });
});
