// The corrections to the two MFA migrations of 2026-08-26.
//
// Each test below is one rule, and its name is the rule. What is asserted is
// what a later edit could quietly undo: the default that must not come back on
// `sesiones.estado`, the length that keeps `credential_id` under the btree
// ceiling, and the pair of indexes the purge needs to be more than a sequential
// scan.

import { describe, it, expect } from "vitest";
import { up, down } from "./20260827000001-harden-mfa-schema.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.map((c) => String(c.args[0])).join("\n");

async function ran(direccion: typeof up | typeof down) {
  const qi = fakeQueryInterface();
  await direccion({ context: qi as never });
  return qi;
}

const LAS_CUATRO = [
  "credencial_webauthn",
  "factor_totp",
  "codigo_recuperacion",
  "dispositivo_recordado",
];

describe("harden-mfa-schema", () => {
  it("takes the lock timeout first, before altering anything", async () => {
    expect(String((await ran(up)).calls[0].args[0])).toContain("lock_timeout");
  });

  it("carries the transaction on every single call", async () => {
    const qi = await ran(up);

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${String(call.args[0])} sin transacción`).toBeDefined();
    }
  });

  it("carries the transaction on every single call, going down too", async () => {
    const qi = await ran(down);

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${String(call.args[0])} sin transacción en down()`).toBeDefined();
    }
  });

  it("drops the default that let a session be minted 'completa' without asking", async () => {
    // The one change here with a security consequence. While that default
    // stands, a raw INSERT — the rescue script the specification plans, a seed,
    // a `.create(...)` missing a field — opens a session with the run of the
    // whole ERP and leaves no trace of the decision.
    expect(sqlOf(await ran(up))).toMatch(
      /ALTER TABLE sesiones ALTER COLUMN estado DROP DEFAULT/i,
    );
  });

  it("caps credential_id at the length WebAuthn allows, well under the btree ceiling", async () => {
    // 1023 bytes is the specification's own limit and base64url of it is
    // ceil(1023 / 3) * 4 = 1364 characters. Anything wider risks the real
    // failure: a unique btree cannot hold an index tuple over 2704 bytes, and
    // it says so at INSERT time in words nobody connects to a passkey.
    expect(sqlOf(await ran(up))).toMatch(
      /ALTER TABLE credencial_webauthn ALTER COLUMN credential_id TYPE VARCHAR\(1364\)/i,
    );
  });

  it("gives created_at a default in the four factor tables and in token_uso_unico", async () => {
    // `created_at` is a fact, not a policy: the value a default supplies is
    // always the right one. `token_uso_unico` is in the list because its own
    // migration claims this default in a comment and Sequelize dropped it —
    // `DataTypes.NOW` in `createTable` emits no DEFAULT at all.
    const sql = sqlOf(await ran(up));

    for (const tabla of [...LAS_CUATRO, "token_uso_unico"]) {
      expect(sql, `${tabla} se queda sin default en created_at`).toMatch(
        new RegExp(`ALTER TABLE ${tabla} ALTER COLUMN created_at SET DEFAULT now\\(\\)`, "i"),
      );
    }
  });

  it("indexes revoked_at, without which the purge's OR reads the whole table", async () => {
    // `dispositivo_recordado (expires_at)` alone does not serve
    // `purgeExpiredRememberedDevices`: it filters by
    // `expires_at < now() OR revoked_at < cutoff`, and an OR with one indexed
    // side is a sequential scan. Measured on 100,000 rows: 2124 buffers and
    // 28.0 ms, against 1038 buffers and 3.4 ms once both sides are indexed.
    const sql = sqlOf(await ran(up));

    expect(sql).toMatch(/CREATE INDEX dispositivo_recordado_revoked_at_idx/i);
    expect(sql, "el índice tiene que ser parcial: sólo interesa la rama revocada del OR").toMatch(
      /WHERE revoked_at IS NOT NULL/i,
    );
  });

  it("renames the four Sequelize-generated indexes to the convention the arc uses", async () => {
    // `sesiones_expires_at_idx` and `token_uso_unico_id_usuario_idx` are what
    // the rest of this arc writes; `addIndex` without a `name` produced
    // `dispositivo_recordado_expires_at`.
    const sql = sqlOf(await ran(up));

    for (const [desde, hacia] of [
      ["credencial_webauthn_id_usuario", "credencial_webauthn_id_usuario_idx"],
      ["codigo_recuperacion_id_usuario", "codigo_recuperacion_id_usuario_idx"],
      ["dispositivo_recordado_id_usuario", "dispositivo_recordado_id_usuario_idx"],
      ["dispositivo_recordado_expires_at", "dispositivo_recordado_expires_at_idx"],
    ]) {
      expect(sql, `${desde} sigue con el nombre que generó Sequelize`).toContain(
        `ALTER INDEX ${desde} RENAME TO ${hacia}`,
      );
    }
  });

  it("puts every one of the five changes back, so the schema dumps match again", async () => {
    // A migration that only goes forward is one nobody can safely deploy on a
    // Friday. Each `up` statement has its opposite here — including restoring
    // the `estado` default, which is a worse schema and the correct reversal.
    const sql = sqlOf(await ran(down));

    expect(sql).toMatch(/ALTER TABLE sesiones ALTER COLUMN estado SET DEFAULT 'completa'/i);
    expect(sql).toMatch(
      /ALTER TABLE credencial_webauthn ALTER COLUMN credential_id TYPE TEXT/i,
    );
    expect(sql).toMatch(/DROP INDEX dispositivo_recordado_revoked_at_idx/i);
    expect(sql).toMatch(/ALTER INDEX dispositivo_recordado_expires_at_idx RENAME TO/i);
    for (const tabla of [...LAS_CUATRO, "token_uso_unico"]) {
      expect(sql, `${tabla} se queda con el default en created_at después del down`).toMatch(
        new RegExp(`ALTER TABLE ${tabla} ALTER COLUMN created_at DROP DEFAULT`, "i"),
      );
    }
  });

  it("renames the indexes back before it drops the one it created", async () => {
    // Order, not just presence. `dispositivo_recordado_revoked_at_idx` is a
    // name this migration invented; renaming the others back first keeps the
    // reversal in the mirror-image order of `up`, which is what makes a
    // half-finished `down` recognisable.
    const qi = await ran(down);

    const renombra = qi.calls.findIndex((c) => String(c.args[0]).startsWith("ALTER INDEX"));
    const borra = qi.calls.findIndex((c) => String(c.args[0]).startsWith("DROP INDEX"));
    expect(renombra).toBeGreaterThanOrEqual(0);
    expect(borra).toBeGreaterThan(renombra);
  });
});
