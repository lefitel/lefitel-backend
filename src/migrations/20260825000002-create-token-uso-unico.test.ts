// The token_uso_unico table.
//
// Tested at the level the other migrations are: what it asks the
// queryInterface for, inside a transaction, with the types and constraints
// the rest of the schema uses — not against a real database. The transaction
// is the part worth pinning: a migration that runs half way leaves the
// deploy in a crash loop.

import { describe, it, expect, vi } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260825000002-create-token-uso-unico.js";

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

/** Every call this migration makes takes its options object as the last argument. */
const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

/** The column spec the migration declared for a given column. */
function columnOf(qi: ReturnType<typeof fakeQueryInterface>, name: string) {
  const create = qi.calls.find((c) => c.fn === "createTable");
  return (create?.args[1] as Record<string, Record<string, unknown>>)[name];
}

describe("create-token-uso-unico", () => {
  it("creates the table with the singular name the design spec gives it", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const create = qi.calls.find((c) => c.fn === "createTable");
    expect(create?.args[0]).toBe("token_uso_unico");
  });

  it("runs everything inside one transaction, and hands that transaction to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });

    // Splitting up() into separate transactions — lock_timeout, then
    // createTable, then the indexes — would still leave every individual
    // call carrying *some* transaction and pass every other assertion here,
    // while reopening exactly the failure the one-transaction rule exists to
    // prevent: createTable commits, addIndex fails, and SequelizeMeta never
    // gets the row, so the next deploy crash-loops on "relation already
    // exists". Counting how many times `transaction()` itself was opened is
    // what catches that.
    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);
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
    for (const name of ["expires_at", "used_at", "created_at"]) {
      expect(columnOf(qi, name).type, name).toBe(DataTypes.DATE);
    }
  });

  it("requires id_usuario, email_destino, token_hash, proposito and expires_at, but not used_at", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    for (const name of ["id_usuario", "email_destino", "token_hash", "proposito", "expires_at"]) {
      expect(columnOf(qi, name).allowNull, name).toBe(false);
    }
    // A token starts unredeemed. used_at is the one date column that has to
    // allow NULL, or every row would have to arrive already used.
    expect(columnOf(qi, "used_at").allowNull).toBe(true);
  });

  it("gives id a primary-key UUID", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id").type).toBe(DataTypes.UUID);
    expect(columnOf(qi, "id").primaryKey).toBe(true);
    expect(columnOf(qi, "id").allowNull).toBe(false);
  });

  it("stores the token hash as a fixed-width CHAR(64), not a looser string type", async () => {
    // The plan's own ASCII diagram of this table (task-2-brief.md) writes
    // VARCHAR(64) for this column. CHAR(64) is used here instead, matching
    // `sesiones.token_hash` and the design spec's own type for that column
    // (§3, "sesion"): SHA-256 hex is always exactly 64 characters, so a
    // variable-width column buys nothing and hides a bug that writes the
    // wrong kind of value. See task-2-report.md for the discrepancy.
    //
    // DataTypes.CHAR(64) builds a new instance on every call, so it cannot be
    // compared with toBe the way DataTypes.DATE and DataTypes.UUID are above —
    // its own rendering of itself is what is checked instead.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(String(columnOf(qi, "token_hash").type)).toBe("CHAR(64)");
  });

  it("gives token_hash a unique constraint, which is its own index", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "token_hash").unique).toBe(true);
  });

  it("gives email_destino and proposito the widths the plan calls for", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(String(columnOf(qi, "email_destino").type)).toBe("VARCHAR(255)");
    expect(String(columnOf(qi, "proposito").type)).toBe("VARCHAR(32)");
  });

  it("gives created_at a real column default, unlike sesiones.created_at", async () => {
    // The plan's diagram writes `created_at TIMESTAMPTZ NOT NULL DEFAULT
    // now()` for this table specifically — `sesiones.created_at` has no such
    // default, because the session store always sets it by hand. This table
    // gets a real default so a row inserted without naming the column (a
    // rescue script, a later task's raw INSERT) still lands with a correct
    // timestamp instead of failing a NOT NULL check.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "created_at").defaultValue).toBe(DataTypes.NOW);
  });

  it("refuses to cascade a user deletion into their outstanding tokens, through a real foreign key", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "id_usuario");
    // onDelete is inert without `references`: delete or misspell it and
    // Sequelize emits no foreign key at all, which only shows up against
    // real Postgres as "relation does not exist" unless references itself
    // is asserted here.
    expect(col.references).toEqual({ model: "usuarios", key: "id" });
    expect(col.onDelete).toBe("RESTRICT");
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

  it("has exactly the eight columns the brief calls for — no more, no less", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const create = qi.calls.find((c) => c.fn === "createTable");
    const columns = create?.args[1] as Record<string, unknown>;
    expect(Object.keys(columns).sort()).toEqual([
      "created_at",
      "email_destino",
      "expires_at",
      "id",
      "id_usuario",
      "proposito",
      "token_hash",
      "used_at",
    ]);
  });

  it("can be undone, inside one transaction", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await down({ context: qi as never });

    expect(spy).toHaveBeenCalledOnce();
    expect(qi.calls.some((c) => c.fn === "dropTable")).toBe(true);
    expect(qi.calls.every((c) => transactionOf(c))).toBe(true);
  });

  it("takes a lock timeout before dropping the table", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    const first = qi.calls[0];
    expect(first.fn).toBe("query");
    expect(String(first.args[0])).toMatch(/lock_timeout/);
  });
});
