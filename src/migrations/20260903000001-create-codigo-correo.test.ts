// The codigo_correo table and the fifth value of `sesiones.mfa_source`.
//
// Tested at the level every other migration here is: what it asks the
// queryInterface for, inside a transaction, with the types and constraints the
// rest of the schema uses — not against a real database. Two things are worth
// pinning beyond the shape: the exact text of the CHECK in both directions —
// an audit of the first draft found `IN` → `NOT IN`, an extra `'sms'`, and a
// reordering all surviving a test written with `toContain` — and that `down`
// refuses while a session still carries `'correo'` instead of failing with
// Postgres's own message.
//
// `as never` on the fake matches the sibling migration tests: the callee takes
// one object whose only member the fake actually implements.

import { describe, it, expect, vi } from "vitest";
import { DataTypes, QueryTypes } from "sequelize";
import { up, down } from "./20260903000001-create-codigo-correo.js";

/** A marker `literal()` returns, so a test can tell it apart from `DataTypes.NOW`. */
const LITERAL = Symbol("literal");

/**
 * @param sesionesConCorreo what `SELECT count(*) … mfa_source = 'correo'` answers.
 *   A string by default, because that is what node-postgres returns for a
 *   BIGINT and what the guard has to cope with.
 */
function fakeQueryInterface(sesionesConCorreo: string | number = "0") {
  const calls: { fn: string; args: unknown[] }[] = [];
  const literales: string[] = [];
  const record =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      const opciones = args.at(-1) as { type?: unknown } | undefined;
      if (fn === "query" && opciones?.type === QueryTypes.SELECT) {
        return Promise.resolve([{ filas: sesionesConCorreo }]);
      }
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

/** The SQL strings handed to `sequelize.query`, in order. */
const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0]));

describe("create-codigo-correo — the shape of the table", () => {
  it("creates it under the singular name the rest of the schema uses", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls.find((c) => c.fn === "createTable")?.args[0]).toBe("codigo_correo");
  });

  it("uses an INTEGER id, because this id never reaches a client", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "id");
    expect(col.type).toEqual(DataTypes.INTEGER);
    expect(col.autoIncrement).toBe(true);
    expect(col.primaryKey).toBe(true);
  });

  it("stores bcrypt of the code, sixty characters, under the name codigo_recuperacion already uses", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "codigo_hash");
    // STRING(60) and not CHAR(64): bcrypt is 60 characters, SHA-256 hex is 64.
    // The type is the difference between "six digits under a slow hash" and
    // "six digits reversed from a dump in milliseconds".
    expect(col.type).toEqual(DataTypes.STRING(60));
    expect(col.allowNull).toBe(false);
    expect(col.unique).toBeUndefined();
  });

  it("counts attempts in the row, starting at zero", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "intentos");
    expect(col.type).toEqual(DataTypes.SMALLINT);
    expect(col.allowNull).toBe(false);
    expect(col.defaultValue).toBe(0);
  });

  it("records where the code went, so it dies with the address", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "email_destino");
    expect(col.type).toEqual(DataTypes.STRING(255));
    expect(col.allowNull).toBe(false);
  });

  it("points id_usuario at usuarios with RESTRICT, like every FK added since 20260804000001", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const col = columnOf(qi, "id_usuario");
    expect(col.allowNull).toBe(false);
    expect(col.references).toEqual({ model: "usuarios", key: "id" });
    expect(col.onDelete).toBe("RESTRICT");
    expect(col.onUpdate).toBe("CASCADE");
  });

  it("leaves used_at nullable and expires_at not", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "used_at").allowNull).toBe(true);
    expect(columnOf(qi, "expires_at").allowNull).toBe(false);
  });

  // 🔴 The measured trap: Sequelize 6.37.8 drops `DataTypes.NOW` from
  // `createTable` without a word. Only `sequelize.literal("now()")` survives.
  it("gives created_at a literal now(), not DataTypes.NOW", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.literales).toContain("now()");
    expect(columnOf(qi, "created_at").defaultValue).not.toBe(DataTypes.NOW);
    expect(columnOf(qi, "created_at").allowNull).toBe(false);
  });
});

describe("create-codigo-correo — the three indexes", () => {
  // 🔴 UNIQUE is the rule "one pending code per account" written into the
  // schema. Two concurrent mints would otherwise both insert, and the spend's
  // single UPDATE would charge an attempt on both rows and return two hashes.
  it("indexes the pending code of an account, partially and UNIQUELY, in raw SQL", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const parcial = sqlOf(qi).find((s) => s.includes("codigo_correo_pendiente_idx"));
    expect(parcial).toBe(
      "CREATE UNIQUE INDEX codigo_correo_pendiente_idx ON codigo_correo (id_usuario) WHERE used_at IS NULL",
    );
  });

  it("indexes (id_usuario, created_at) for the cooldown and the caps, and expires_at for the purge", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const indices = qi.calls.filter((c) => c.fn === "addIndex").map((c) => c.args[1]);
    expect(indices).toHaveLength(2);
    expect(indices).toContainEqual(
      expect.objectContaining({
        fields: ["id_usuario", "created_at"],
        name: "codigo_correo_cuenta_creado_idx",
      }),
    );
    expect(indices).toContainEqual(
      expect.objectContaining({ fields: ["expires_at"], name: "codigo_correo_expires_at_idx" }),
    );
  });
});

/** What `20260826000002` wrote, byte for byte, so `down` restores it exactly. */
const RESTRICCION_ANTES =
  "ALTER TABLE sesiones ADD CONSTRAINT sesiones_mfa_source_chk " +
  "CHECK (mfa_source IS NULL OR mfa_source IN ('passkey', 'totp', 'codigo', 'dispositivo'))";
/** The same, plus the fifth word. */
const RESTRICCION_AHORA =
  "ALTER TABLE sesiones ADD CONSTRAINT sesiones_mfa_source_chk " +
  "CHECK (mfa_source IS NULL OR mfa_source IN ('passkey', 'totp', 'codigo', 'dispositivo', 'correo'))";

describe("create-codigo-correo — the fifth value of mfa_source", () => {
  // Full-string equality, deliberately. A first draft checked the five words
  // with `toContain` and let `IN` → `NOT IN` (every MFA login dies on the
  // constraint), an added `'sms'`, and a reordered list all pass.
  it("recreates the constraint with 'correo' beside the four values 20260826000002 allowed, exactly", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(sqlOf(qi)).toContain(RESTRICCION_AHORA);
  });

  it("drops the old constraint first, IF EXISTS, and adds the new one plainly — no NOT VALID", async () => {
    // Inside one transaction the `NOT VALID` + `VALIDATE` pair scans under
    // the same ACCESS EXCLUSIVE lock a plain ADD does (locks are held to
    // commit); the header says why the plain form is the honest one here.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);
    const drop = sql.indexOf("ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_mfa_source_chk");
    const add = sql.indexOf(RESTRICCION_AHORA);
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    expect(sql.some((s) => /NOT VALID|VALIDATE CONSTRAINT/.test(s))).toBe(false);
  });
});

describe("create-codigo-correo — how it runs", () => {
  it("opens exactly one transaction and hands it to every call", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });
    expect(spy).toHaveBeenCalledTimes(1);
    for (const call of qi.calls) expect(transactionOf(call)).toEqual({ id: "t" });
  });

  it("sets lock_timeout before touching anything", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls[0].fn).toBe("query");
    expect(qi.calls[0].args[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });
});

describe("create-codigo-correo — down", () => {
  it("narrows the constraint back to the four values and drops the table, in one transaction", async () => {
    const qi = fakeQueryInterface("0");
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await down({ context: qi as never });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(qi.calls[0].args[0]).toBe("SET LOCAL lock_timeout = '5s'");
    // Byte for byte what `20260826000002` wrote: the only cheap proof the
    // migration is reversible.
    expect(sqlOf(qi)).toContain(RESTRICCION_ANTES);
    expect(sqlOf(qi).some((s) => s.includes("'correo'") && s.startsWith("ALTER TABLE"))).toBe(false);
    expect(qi.calls.find((c) => c.fn === "dropTable")?.args[0]).toBe("codigo_correo");
    for (const call of qi.calls) expect(transactionOf(call)).toEqual({ id: "t" });
  });

  it("counts the sessions carrying 'correo' before altering anything", async () => {
    const qi = fakeQueryInterface("0");
    await down({ context: qi as never });
    const sql = sqlOf(qi);
    const count = sql.findIndex((s) => s.includes("count(*)") && s.includes("mfa_source = 'correo'"));
    const firstAlter = sql.findIndex((s) => s.startsWith("ALTER TABLE"));
    expect(count).toBeGreaterThan(-1);
    expect(count).toBeLessThan(firstAlter);
    expect(qi.calls.filter((c) => c.fn === "query")[count].args[1]).toMatchObject({ type: QueryTypes.SELECT });
  });

  // 🔴 The guard, and the trap inside it: `count(*)` arrives as a string.
  it("refuses while a session still carries 'correo', naming the statement that clears it", async () => {
    const qi = fakeQueryInterface("2");
    await expect(down({ context: qi as never })).rejects.toThrow(
      "DELETE FROM sesiones WHERE mfa_source = 'correo'",
    );
    expect(qi.calls.some((c) => c.fn === "dropTable")).toBe(false);
    expect(sqlOf(qi).some((s) => s.startsWith("ALTER TABLE"))).toBe(false);
  });

  it("lets the rollback through when the count comes back as the string \"0\"", async () => {
    // `"0"` is truthy; a guard written `if (filas)` would refuse every rollback.
    const qi = fakeQueryInterface("0");
    await expect(down({ context: qi as never })).resolves.toBeUndefined();
    expect(qi.calls.some((c) => c.fn === "dropTable")).toBe(true);
  });
});
