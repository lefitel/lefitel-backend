// The session table.
//
// Tested at the level the other migrations are: that it asks the queryInterface
// for the right things, inside a transaction, with the types and the constraints
// the rest of the schema uses. The transaction is the part worth pinning: a
// migration that runs half way leaves the deploy in a crash loop.

import { describe, it, expect, vi } from "vitest";
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

/** Every call this migration makes takes its options object as the last argument. */
const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

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

  it("runs everything inside one transaction, and hands that transaction to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });

    // `spy` is the part the original version of this test was missing: the
    // fake's `transaction` was never wrapped by `record`, so nothing counted
    // how many times it was opened. Splitting up() into three transactions in
    // a row — lock_timeout, then createTable, then the indexes — still left
    // every recorded call carrying *some* transaction and passed every other
    // assertion here, while recreating exactly the failure the one-transaction
    // rule exists to prevent: createTable commits, addIndex fails, and
    // SequelizeMeta never gets the row, so the next deploy crash-loops on
    // "relation already exists".
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
    for (const name of ["created_at", "last_used_at", "expires_at", "revoked_at"]) {
      expect(columnOf(qi, name).type, name).toBe(DataTypes.DATE);
    }
  });

  it("requires the three dates that are never absent, but not the one that means 'still live'", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    for (const name of ["created_at", "last_used_at", "expires_at"]) {
      expect(columnOf(qi, name).allowNull, name).toBe(false);
    }
    // revoked_at is null for every session that has not been ended yet — the
    // common case — so it is the one date column that must allow it.
    expect(columnOf(qi, "revoked_at").allowNull).toBe(true);
  });

  it("gives id a primary-key UUID", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id").type).toBe(DataTypes.UUID);
    expect(columnOf(qi, "id").primaryKey).toBe(true);
    expect(columnOf(qi, "id").allowNull).toBe(false);
  });

  it("stores the token hash as a fixed-width CHAR(64), not a looser string type", async () => {
    // STRING(64) or TEXT would pass every other assertion here — same length,
    // same uniqueness, same not-null. CHAR is the deliberate choice: SHA-256
    // hex is always exactly 64 characters, so a variable-width column buys
    // nothing and a wider one hides a bug that writes the wrong kind of value.
    //
    // DataTypes.CHAR(64) builds a new instance on every call, so it cannot be
    // compared with toBe the way DataTypes.DATE and DataTypes.UUID are above —
    // its own rendering of itself is what is checked instead.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(String(columnOf(qi, "token_hash").type)).toBe("CHAR(64)");
  });

  it("will not accept a session without an owner or a token", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id_usuario").allowNull).toBe(false);
    expect(columnOf(qi, "token_hash").allowNull).toBe(false);
    expect(columnOf(qi, "token_hash").unique).toBe(true);
  });

  it("refuses to cascade a user deletion into their sessions, through a real foreign key", async () => {
    // The seventeen existing foreign keys in this schema are ON DELETE CASCADE,
    // and `rol` is the only model without soft deletion — so deleting a role
    // has already been measured taking 6 users, 958 poles and 4835 revisions
    // with it. A session table on CASCADE would join that list.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "id_usuario");
    // onDelete is inert without `references`: delete or misspell it — this
    // schema's own history is `ciudads`, `rols`, `revicions` — and Sequelize
    // emits no foreign key at all, so onDelete has nothing to attach to. That
    // only shows up against real Postgres, as "relation does not exist", never
    // in this suite unless references itself is asserted.
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

  it("has exactly the nine columns this plan calls for — no more, no less", async () => {
    // §3 of the design describes this table with columns this plan does not
    // use yet: mfa_satisfied_at, mfa_source, estado, webauthn_challenge,
    // challenge_expires_at. Those belong to a later MFA plan. A column nobody
    // writes is a trap for whoever reads the schema next and assumes it means
    // something, so this checks the boundary from both sides at once: nothing
    // missing, and nothing from that later plan arriving early.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const create = qi.calls.find((c) => c.fn === "createTable");
    const columns = create?.args[1] as Record<string, unknown>;
    expect(Object.keys(columns).sort()).toEqual([
      "created_at",
      "expires_at",
      "id",
      "id_usuario",
      "ip_address",
      "last_used_at",
      "revoked_at",
      "token_hash",
      "user_agent",
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
    // Deleting this line from down() left every other assertion about the
    // rollback green: dropTable still happens, still inside a transaction.
    // Only pinning the first call catches it going missing.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    const first = qi.calls[0];
    expect(first.fn).toBe("query");
    expect(String(first.args[0])).toMatch(/lock_timeout/);
  });
});
