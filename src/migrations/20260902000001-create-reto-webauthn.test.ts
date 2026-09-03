// The reto_webauthn table.
//
// Tested at the level every other migration here is: what it asks the
// queryInterface for, inside a transaction, with the types and constraints the
// rest of the schema uses — not against a real database. The transaction is the
// part worth pinning: a migration that runs half way leaves the deploy in a
// crash loop.
//
// `as never` on the fake matches the eight sibling migration tests. It is not
// the trap it was in `factorInventory.test.ts` — there it hid a real argument
// mismatch on a production function; here the callee takes one object whose
// only member the fake actually implements.

import { describe, it, expect, vi } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260902000001-create-reto-webauthn.js";

/** A marker `literal()` returns, so a test can tell it apart from `DataTypes.NOW`. */
const LITERAL = Symbol("literal");

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const literales: string[] = [];
  const record =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return Promise.resolve();
    };
  return {
    calls,
    literales,
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addIndex: record("addIndex"),
    sequelize: {
      query: record("query"),
      literal: (sql: string) => {
        literales.push(sql);
        return { [LITERAL]: sql };
      },
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

describe("create-reto-webauthn — the shape of the table", () => {
  it("creates it under the singular name the rest of the schema uses", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls.find((c) => c.fn === "createTable")?.args[0]).toBe("reto_webauthn");
  });

  it("stores a hash of the challenge and never the challenge", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "reto_hash");

    // CHAR(64) and not VARCHAR: SHA-256 hex is always exactly 64 characters,
    // and a variable-width column would hide a bug writing the wrong shape.
    expect(col.type).toEqual(DataTypes.CHAR(64));
    expect(col.allowNull).toBe(false);
    expect(col.unique).toBe(true);
  });

  it("carries the purpose, because it is a control and not a label", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "proposito");

    // 🔴 This column goes inside the `WHERE` that spends a challenge. Without
    // it, one minted to register a credential can complete an authentication.
    expect(col.allowNull).toBe(false);
  });
});

describe("create-reto-webauthn — the two nullable columns, which are the point", () => {
  // 🔴 The single reason this table exists rather than two columns on
  // `sesiones`. Null means the passwordless ceremony, where nobody is named
  // until the assertion verifies. Making this NOT NULL would compile, pass
  // every other test in this file, and make phase 2 impossible — at which
  // point the cheap-looking fix is relaxing `sesiones.id_usuario` instead,
  // which eleven layers reject and which throws people out of other tabs.
  it("leaves id_usuario nullable, so a ceremony can start with nobody named", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id_usuario").allowNull).toBe(true);
  });

  it("points id_usuario at usuarios with RESTRICT, like every FK added since 20260804000001", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "id_usuario");
    expect(col.references).toEqual({ model: "usuarios", key: "id" });
    expect(col.onDelete).toBe("RESTRICT");
    expect(col.onUpdate).toBe("CASCADE");
  });

  // 🔴 CASCADE here and RESTRICT above, and the asymmetry is deliberate.
  // `purgeExpiredSessions` deletes session rows; with RESTRICT a two-minute
  // challenge would block that purge outright, and the purge runs with no
  // LIMIT in a single statement. A challenge whose session is gone is
  // worthless anyway.
  it("lets a challenge leave with the session that asked for it", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "id_sesion");
    expect(col.allowNull).toBe(true);
    expect(col.references).toEqual({ model: "sesiones", key: "id" });
    expect(col.onDelete).toBe("CASCADE");
  });
});

describe("create-reto-webauthn — created_at gets a default that actually exists", () => {
  // 🔴 The measured trap. Sequelize 6.37.8 drops `DataTypes.NOW` from
  // `createTable` without a word, so `token_uso_unico` shipped with no default
  // while its own migration carried a paragraph explaining the safety net it
  // thought it had. Only `sequelize.literal("now()")` survives into the SQL.
  // This test is the difference between the two, and it is the only thing that
  // would catch a future edit "simplifying" the literal back into the constant.
  it("uses a literal now(), not DataTypes.NOW", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.literales).toContain("now()");
    expect(columnOf(qi, "created_at").defaultValue).not.toBe(DataTypes.NOW);
    expect(columnOf(qi, "created_at").allowNull).toBe(false);
  });
});

describe("create-reto-webauthn — how it runs", () => {
  it("opens exactly one transaction and hands it to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });

    // Splitting `up` into separate transactions would still leave every
    // individual call carrying *some* transaction and pass the assertion
    // below, while reopening the failure the one-transaction rule exists to
    // prevent: createTable commits, addIndex fails, SequelizeMeta never gets
    // the row, and the next deploy crash-loops on "relation already exists".
    expect(spy).toHaveBeenCalledTimes(1);
    for (const call of qi.calls) expect(transactionOf(call)).toEqual({ id: "t" });
  });

  it("sets lock_timeout before touching anything", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    // First, not merely present: a lock timeout set after `createTable` has
    // already queued behind whatever is holding `usuarios` protects nothing.
    expect(qi.calls[0].fn).toBe("query");
    expect(qi.calls[0].args[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it("indexes expiry for the purge, and nothing else", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const indices = qi.calls.filter((c) => c.fn === "addIndex");

    // One index, deliberately. No `id_usuario` index unlike `token_uso_unico`:
    // nothing ever asks which challenges belong to a person, every read names
    // one hash, and an unused index is write cost on the ceremony's hot path.
    expect(indices).toHaveLength(1);
    expect(indices[0].args[1]).toMatchObject({
      fields: ["expires_at"],
      name: "reto_webauthn_expires_at_idx",
    });
  });

  it("down drops the table, inside its own transaction and with the same timeout", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(qi.calls[0].args[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(qi.calls.find((c) => c.fn === "dropTable")?.args[0]).toBe("reto_webauthn");
    for (const call of qi.calls) expect(transactionOf(call)).toEqual({ id: "t" });
  });
});
