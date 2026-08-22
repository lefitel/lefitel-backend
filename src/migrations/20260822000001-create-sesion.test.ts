// The session table.
//
// Tested at the level the other migrations are: that it asks the queryInterface
// for the right things, inside a transaction, with the types and the constraints
// the rest of the schema uses. The transaction is the part worth pinning: a
// migration that runs half way leaves the deploy in a crash loop.

import { describe, it, expect } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260822000001-create-sesion.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addIndex: record("addIndex"),
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

/** The column spec the migration declared for a given column. */
function columnOf(qi: ReturnType<typeof fakeQueryInterface>, name: string) {
  const create = qi.calls.find((c) => c.fn === "createTable");
  return (create?.args[1] as Record<string, Record<string, unknown>>)[name];
}

describe("create-sesion", () => {
  it("creates the table with the plural name Sequelize expects", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const create = qi.calls.find((c) => c.fn === "createTable");
    expect(create?.args[0]).toBe("sesiones");
  });

  it("runs everything inside one transaction", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => (c.args.at(-1) as { transaction?: unknown })?.transaction)).toBe(true);
  });

  it("takes a lock timeout before touching anything", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const first = qi.calls[0];
    expect(first.fn).toBe("query");
    expect(String(first.args[0])).toMatch(/lock_timeout/);
  });

  it("gives every date column a timezone", async () => {
    // TIMESTAMP without a zone against a server in UTC and a database in
    // Bolivia puts every expiry four hours out. Silently.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    for (const name of ["created_at", "last_used_at", "expires_at", "revoked_at"]) {
      expect(columnOf(qi, name).type, name).toBe(DataTypes.DATE);
    }
  });

  it("will not accept a session without an owner or a token", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id_usuario").allowNull).toBe(false);
    expect(columnOf(qi, "token_hash").allowNull).toBe(false);
    expect(columnOf(qi, "token_hash").unique).toBe(true);
  });

  it("refuses to cascade a user deletion into their sessions", async () => {
    // The seventeen existing foreign keys in this schema are ON DELETE CASCADE,
    // and `rol` is the only model without soft deletion — so deleting a role
    // has already been measured taking 6 users, 958 poles and 4835 revisions
    // with it. A session table on CASCADE would join that list.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id_usuario").onDelete).toBe("RESTRICT");
  });

  it("indexes what the queries actually filter by", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const indexed = qi.calls
      .filter((c) => c.fn === "addIndex")
      .map((c) => (c.args[1] as { fields: string[] }).fields.join(","));
    expect(indexed).toContain("id_usuario");
    expect(indexed).toContain("expires_at");
  });

  it("can be undone, inside a transaction", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    expect(qi.calls.some((c) => c.fn === "dropTable")).toBe(true);
    expect(qi.calls.every((c) => (c.args.at(-1) as { transaction?: unknown })?.transaction)).toBe(true);
  });
});
