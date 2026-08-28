// The four factor models, checked against the migration that creates their
// tables — not against each other, and not against either file's source
// text.
//
// Fix round 1 found two problems in the previous version of this file, both
// from testing source text instead of the real objects:
//
// 1. `toContain("timestamps: false")` (and the equivalent check for
//    `estado`/`mfa_satisfied_at`/`mfa_source`) is defeated by a doc comment
//    that happens to mention the same phrase in prose. Three of the four
//    models, plus `sesion.model.ts`, carry exactly that kind of comment —
//    flipping `timestamps: false` to `true` in any of them left the old
//    assertion green.
// 2. The migration-side check sliced from a table's `createTable(` call to
//    *end of file*, not to the next table. For `credencial_webauthn` — the
//    first table created — that slice covered 83% of the migration file and
//    quietly included every other table's columns, so a model that declared
//    a sibling table's column by mistake would not have been caught.
//
// Both are fixed the same way: ask the real object instead of grepping
// prose. Sequelize models are introspectable with no database connection —
// `getTableName()`, `.options.timestamps`, `getAttributes()` — and the
// migration's `up()` can be run here too, against a fake queryInterface that
// only records what `createTable` was called with (the same technique
// `20260826000003-create-factor-tables.test.ts` already uses). That records
// each table's exact column set as a JS object, not a slice of text, so
// there is no slicing left to get wrong.
//
// What this file still exists to catch: a model whose `tableName` or column
// names drift from the migration compiles, passes every unit test that mocks
// it, and fails at runtime with "no existe la columna". That is exactly what
// took `GET /api/usuario/1` down on 2026-08-26: `rol.model.ts` declared
// `paranoid: true` against a table with no `deletedAt`, and every query that
// touched roles returned a 500.

import { describe, it, expect } from "vitest";
import { up } from "../migrations/20260826000003-create-factor-tables.js";
import { CredencialWebauthnModel } from "./credencialWebauthn.model.js";
import { FactorTotpModel } from "./factorTotp.model.js";
import { CodigoRecuperacionModel } from "./codigoRecuperacion.model.js";
import { DispositivoRecordadoModel } from "./dispositivoRecordado.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { SesionModel } from "./sesion.model.js";

// The four models have four distinct generic ModelDefined<S, C> types, which
// cannot share an array element type without erasing the parts that differ.
// This interface keeps only what these tests actually call — the same three
// static members every Sequelize model exposes regardless of its attributes
// — so the loop below can stay a loop instead of four copy-pasted blocks.
interface FactorModel {
  getTableName(): unknown;
  readonly options: { timestamps?: boolean };
  getAttributes(): Record<string, unknown>;
}

const MODELOS: { Model: FactorModel; tabla: string }[] = [
  { Model: CredencialWebauthnModel, tabla: "credencial_webauthn" },
  { Model: FactorTotpModel, tabla: "factor_totp" },
  { Model: CodigoRecuperacionModel, tabla: "codigo_recuperacion" },
  { Model: DispositivoRecordadoModel, tabla: "dispositivo_recordado" },
];

/**
 * Records what the real migration calls `createTable` with, per table — the
 * exact column-definition object Sequelize would send to Postgres, not a
 * slice of the file's text. No database is touched: `createTable`,
 * `addIndex` and `sequelize.query` just resolve, the same shape
 * `20260826000003-create-factor-tables.test.ts` already relies on to test
 * this same migration.
 */
async function tablasDeLaMigracion() {
  const tablas: Record<string, Record<string, unknown>> = {};
  const qi = {
    createTable: (nombre: string, columnas: Record<string, unknown>) => {
      tablas[nombre] = columnas;
      return Promise.resolve();
    },
    addIndex: () => Promise.resolve(),
    sequelize: {
      query: () => Promise.resolve(),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
  await up({ context: qi as never });
  return tablas;
}

describe("the factor models name the tables their migration creates", () => {
  it("sets tableName explicitly on every one", () => {
    // Sequelize's default pluralisation produced `ciudads`, `rols` and
    // `revicions` in this schema. Left to it, `factor_totp` becomes
    // `factor_totps` and nothing in this repo creates that table.
    // `getTableName()` reads Sequelize's own resolved name, so a comment
    // claiming the right name cannot satisfy this the way it could a text
    // search.
    for (const { Model, tabla } of MODELOS) {
      expect(Model.getTableName(), `no fija tableName: "${tabla}"`).toBe(tabla);
    }
  });

  it("turns Sequelize's automatic timestamps off, because these tables have none", () => {
    // The migration writes `created_at`, not `createdAt`/`updatedAt`. With
    // timestamps left on, every INSERT names two columns that do not exist.
    // `.options.timestamps` is what Sequelize actually decided, independent
    // of whatever a doc comment nearby happens to say.
    for (const { Model, tabla } of MODELOS) {
      expect(Model.options.timestamps, `"${tabla}" deja los timestamps automáticos puestos`).toBe(
        false,
      );
    }
  });

  it("declares exactly the columns its own table's createTable call gets — no more, no fewer", async () => {
    // Exact set equality, not two one-directional checks: a model in this
    // codebase always declares every column of its table (there is no
    // pattern here of a model deliberately omitting a nullable column), so
    // "no extra column" and "no missing column" collapse into one comparison
    // and there is nothing a separate NOT-NULL-only pass would still catch.
    const tablas = await tablasDeLaMigracion();
    for (const { Model, tabla } of MODELOS) {
      const columnasMigracion = Object.keys(tablas[tabla] ?? {}).sort();
      const columnasModelo = Object.keys(Model.getAttributes()).sort();
      expect(columnasModelo, `el modelo de "${tabla}" no coincide con las columnas de la migración`).toEqual(
        columnasMigracion,
      );
    }
  });
});

describe("the two tables that gained columns declare them too", () => {
  it("usuario carries the grace deadline and the password date", () => {
    const attrs = UsuarioModel.getAttributes();
    expect(attrs).toHaveProperty("mfa_grace_until");
    expect(attrs).toHaveProperty("pass_changed_at");
  });

  it("sesion carries the state and the proof of a factor", () => {
    const attrs = SesionModel.getAttributes();
    expect(attrs).toHaveProperty("estado");
    expect(attrs).toHaveProperty("mfa_satisfied_at");
    expect(attrs).toHaveProperty("mfa_source");
  });

  it("leaves sesion.estado with no default, so nothing mints a session by omission", () => {
    // `estado` decides what a session may reach. A default — here or in the
    // column, and `20260827000001` removed it from the column — answers that
    // question for a caller who never asked it, and the answer it gave was
    // `completa`: the run of the whole ERP, with no error and no trace.
    // `createSession` refuses a default for exactly this reason; the model has
    // to refuse it too, or the argument only holds on one side.
    expect(SesionModel.getAttributes().estado.defaultValue).toBeUndefined();
  });

  it("rejects a session built without an estado, instead of choosing one for it", async () => {
    // The rule the test above only describes from the outside, asserted as
    // behaviour — and it is the one that carries the weight, because **the
    // compiler does not enforce this**. `tsconfig.json` sets `"strict": false`,
    // which makes null and undefined assignable to everything and collapses
    // Sequelize's `MakeNullishOptional`: `SesionModel.create({})`, with no
    // fields at all, typechecks clean. Measured, not assumed.
    //
    // What does refuse is Sequelize's own notNull validation, and only while
    // `estado` carries no `defaultValue`. Put one back and this goes green
    // again while every session created by omission silently becomes
    // `completa`.
    const sinEstado = SesionModel.build({
      id_usuario: 1,
      token_hash: "x".repeat(64),
      user_agent: null,
      ip_address: null,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(),
      revoked_at: null,
      mfa_satisfied_at: null,
      mfa_source: null,
    } as never);

    await expect(sinEstado.validate()).rejects.toThrow(/estado/);
  });

  it("declares credential_id with the length its column has, not an unbounded TEXT", () => {
    // The column is `VARCHAR(1364)` — base64url of the 1023 bytes WebAuthn
    // allows. A model still saying TEXT would let Sequelize build an INSERT
    // Postgres then refuses, and the refusal comes from the unique btree
    // (`index row size ... exceeds maximum 2704`), which reads like a database
    // fault rather than an oversized credential.
    const tipo = CredencialWebauthnModel.getAttributes().credential_id.type;
    expect(String(tipo)).toBe("VARCHAR(1364)");
  });
});
