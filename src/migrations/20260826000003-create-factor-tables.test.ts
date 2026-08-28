// The four tables the factors live in. Created empty: nothing reads them until
// plans 4B and 4C.
//
// What is asserted here is the shape that later plans cannot fix cheaply — a
// missing UNIQUE on `credential_id` is an authentication bypass, and a
// `factor_totp` row without its IV and auth tag is a secret that can never be
// decrypted again.

import { describe, it, expect } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260826000003-create-factor-tables.js";

const TABLAS = [
  "credencial_webauthn",
  "factor_totp",
  "codigo_recuperacion",
  "dispositivo_recordado",
];

/**
 * `filasPorTabla` is what the guard in `down` sees when it counts.
 *
 * The counts come back as **strings**, which is not pedantry: `count(*)` is a
 * BIGINT and node-postgres hands those over as strings, so a guard written as
 * `filas > 0` is true for "0" and would refuse every rollback for ever.
 */
function fakeQueryInterface(filasPorTabla: Record<string, number> = {}) {
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
      query: (...args: unknown[]) => {
        calls.push({ fn: "query", args });
        if (!String(args[0]).includes("count(*)")) return Promise.resolve(undefined);
        return Promise.resolve(
          TABLAS.map((tabla) => ({ tabla, filas: String(filasPorTabla[tabla] ?? 0) })),
        );
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const tableOf = (qi: ReturnType<typeof fakeQueryInterface>, name: string) =>
  qi.calls.find((c) => c.fn === "createTable" && c.args[0] === name)?.args[1] as
    | Record<
        string,
        { type?: unknown; allowNull?: boolean; unique?: boolean; references?: unknown; onDelete?: string }
      >
    | undefined;

async function withUp() {
  const qi = fakeQueryInterface();
  await up({ context: qi as never });
  return qi;
}

describe("create-factor-tables", () => {
  it("creates the four tables, under the names the spec gives them", async () => {
    const qi = await withUp();

    const created = qi.calls.filter((c) => c.fn === "createTable").map((c) => c.args[0]);
    expect(created).toEqual([
      "credencial_webauthn",
      "factor_totp",
      "codigo_recuperacion",
      "dispositivo_recordado",
    ]);
  });

  it("carries the transaction on every single call", async () => {
    const qi = await withUp();

    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn}(${String(call.args[0])}) sin transacción`).toBeDefined();
    }
  });

  it("takes the lock timeout first, before creating anything", async () => {
    const qi = await withUp();

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });

  it("carries the transaction on every single call, going down too", async () => {
    // The up-path test above only guards the forward direction. A migration
    // that reverses half way — four tables dropped and the fifth call missing
    // its transaction — is the exact failure this rule exists for, and it was
    // only checked in one direction until now.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn}(${String(call.args[0])}) sin transacción en down()`).toBeDefined();
    }
  });

  it("makes credential_id unique, which is the whole of the lookup's safety", async () => {
    // A passkey assertion names its credential. If two rows could carry the
    // same id, the lookup picks one of them and the public key it verifies
    // against may not be the one that signed — and, worse, may belong to a
    // different account.
    const qi = await withUp();

    expect(tableOf(qi, "credencial_webauthn")?.credential_id?.unique).toBe(true);
  });

  it("stores the TOTP nonce and auth tag beside the ciphertext", async () => {
    // Without both, the secret is unrecoverable from the first minute: AES-GCM
    // cannot decrypt without its IV, and cannot be trusted without its tag.
    const totp = tableOf(await withUp(), "factor_totp");
    expect(totp?.secreto_cifrado?.allowNull).toBe(false);
    expect(totp?.iv?.allowNull).toBe(false);
    expect(totp?.auth_tag?.allowNull).toBe(false);
    expect(totp?.key_version?.allowNull).toBe(false);
  });

  it("pins the IV to 12 bytes and the tag to 16", async () => {
    // BYTEA has no length in Postgres, so the only place this can be enforced
    // is a CHECK. A 16-byte IV silently changes the GCM construction, and a
    // truncated tag weakens the authentication it exists to provide.
    const qi = await withUp();

    const sql = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");
    expect(sql).toMatch(/octet_length\(iv\)\s*=\s*12/);
    expect(sql).toMatch(/octet_length\(auth_tag\)\s*=\s*16/);
  });

  it("allows one TOTP factor per account and no more", async () => {
    const qi = await withUp();

    expect(tableOf(qi, "factor_totp")?.id_usuario?.unique).toBe(true);
  });

  it("ties every table to usuarios with RESTRICT, never CASCADE", async () => {
    // The delete here is logical (`paranoid`), so no cascade ever fires. A
    // CASCADE written anyway reads as cleanup that happens and does not.
    const qi = await withUp();

    for (const name of [
      "credencial_webauthn",
      "factor_totp",
      "codigo_recuperacion",
      "dispositivo_recordado",
    ]) {
      const col = tableOf(qi, name)?.id_usuario;
      expect(col?.allowNull, `${name}.id_usuario`).toBe(false);
      expect(col?.references, `${name}.id_usuario`).toBeDefined();
      expect(col?.onDelete, `${name}.id_usuario`).toBe("RESTRICT");
    }
  });

  it("indexes what the queries actually filter by", async () => {
    const qi = await withUp();

    const indexed = qi.calls
      .filter((c) => c.fn === "addIndex")
      .map((c) => [c.args[0], (c.args[1] as { fields: string[] }).fields.join(",")]);
    expect(indexed).toEqual(
      expect.arrayContaining([
        ["credencial_webauthn", "id_usuario"],
        ["codigo_recuperacion", "id_usuario"],
        ["dispositivo_recordado", "id_usuario"],
        ["dispositivo_recordado", "expires_at"],
      ]),
    );
  });

  it("gives every timestamp column a timezone, like every other timestamp in this schema", async () => {
    // TIMESTAMPTZ is a hard constraint on this project; DataTypes.DATE is what
    // Sequelize maps to it. Nothing here would catch a typo swapping it for a
    // naive type except an explicit check of the type each column carries.
    const qi = await withUp();

    const typeOf = (table: string, column: string) => tableOf(qi, table)?.[column]?.type;

    expect(typeOf("credencial_webauthn", "created_at")).toBe(DataTypes.DATE);
    expect(typeOf("credencial_webauthn", "last_used_at")).toBe(DataTypes.DATE);
    expect(typeOf("factor_totp", "confirmed_at")).toBe(DataTypes.DATE);
    expect(typeOf("factor_totp", "created_at")).toBe(DataTypes.DATE);
    expect(typeOf("codigo_recuperacion", "used_at")).toBe(DataTypes.DATE);
    expect(typeOf("codigo_recuperacion", "created_at")).toBe(DataTypes.DATE);
    expect(typeOf("dispositivo_recordado", "created_at")).toBe(DataTypes.DATE);
    expect(typeOf("dispositivo_recordado", "expires_at")).toBe(DataTypes.DATE);
    expect(typeOf("dispositivo_recordado", "revoked_at")).toBe(DataTypes.DATE);
  });

  it("gives the secret-bearing columns a binary type, not text", async () => {
    // A secret stored as TEXT invites accidental encoding conversions and
    // string-shaped bugs (trimming, case-folding) that BYTEA is immune to.
    // `public_key`, `secreto_cifrado`, `iv` and `auth_tag` all have to survive
    // a byte-for-byte round trip.
    const qi = await withUp();

    const typeOf = (table: string, column: string) => tableOf(qi, table)?.[column]?.type;

    expect(typeOf("credencial_webauthn", "public_key")).toBe(DataTypes.BLOB);
    expect(typeOf("factor_totp", "secreto_cifrado")).toBe(DataTypes.BLOB);
    expect(typeOf("factor_totp", "iv")).toBe(DataTypes.BLOB);
    expect(typeOf("factor_totp", "auth_tag")).toBe(DataTypes.BLOB);
  });

  it("drops the tables in reverse order", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const dropped = qi.calls.filter((c) => c.fn === "dropTable").map((c) => c.args[0]);
    expect(dropped).toEqual([
      "dispositivo_recordado",
      "codigo_recuperacion",
      "factor_totp",
      "credencial_webauthn",
    ]);
  });

  it("takes the lock timeout first, before dropping anything", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });

  it("refuses to undo when any of the four tables still has rows", async () => {
    // What a rollback would take with it is not recoverable from anywhere
    // else: a TOTP secret was shown once, as a QR code, and the plaintext was
    // never stored. Same for the passkeys, the unused recovery codes and the
    // remembered devices. `dropTable` asks nobody.
    const qi = fakeQueryInterface({ factor_totp: 3 });

    await expect(down({ context: qi as never })).rejects.toThrow();
    expect(qi.calls.filter((c) => c.fn === "dropTable")).toHaveLength(0);
  });

  it("names the tables that still have rows, and how many, in the refusal", async () => {
    // A refusal that does not say what is in the way sends the operator to
    // read the migration source during an incident.
    const qi = fakeQueryInterface({ factor_totp: 3, codigo_recuperacion: 40 });

    await expect(down({ context: qi as never })).rejects.toThrow(/factor_totp \(3\)/);
    await expect(down({ context: qi as never })).rejects.toThrow(/codigo_recuperacion \(40\)/);
  });

  it("counts every one of the four tables, not just the first one it finds", async () => {
    // A guard that stops at `credencial_webauthn` would wave through the
    // rollback of a database whose only rows are TOTP secrets.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const conteo = qi.calls.find((c) => c.fn === "query" && String(c.args[0]).includes("count(*)"));
    expect(conteo, "down() no cuenta las filas antes de borrar").toBeDefined();
    for (const tabla of TABLAS) {
      expect(String(conteo?.args[0]), `${tabla} no se cuenta`).toContain(tabla);
    }
  });

  it("lets the rollback through when the four tables are empty", async () => {
    // The guard is about data loss, not about forbidding rollbacks. With
    // nothing in the tables there is nothing to lose, and 4A has to stay
    // reversible.
    const qi = fakeQueryInterface();

    await expect(down({ context: qi as never })).resolves.toBeUndefined();
    expect(qi.calls.filter((c) => c.fn === "dropTable")).toHaveLength(4);
  });
});
