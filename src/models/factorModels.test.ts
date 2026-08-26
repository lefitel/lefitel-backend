// The four factor models, checked against the migration that creates their
// tables — not against each other.
//
// A model whose `tableName` or column names drift from the migration compiles,
// passes every unit test that mocks it, and fails at runtime with "no existe la
// columna". That is the failure mode this file exists for, and it is exactly
// the one that took `GET /api/usuario/1` down on 2026-08-26: `rol.model.ts`
// declared `paranoid: true` against a table with no `deletedAt`, and every
// query that touched roles returned a 500.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MIGRACION = readFileSync("src/migrations/20260826000003-create-factor-tables.ts", "utf8");

const MODELOS = [
  { fichero: "src/models/credencialWebauthn.model.ts", tabla: "credencial_webauthn" },
  { fichero: "src/models/factorTotp.model.ts", tabla: "factor_totp" },
  { fichero: "src/models/codigoRecuperacion.model.ts", tabla: "codigo_recuperacion" },
  { fichero: "src/models/dispositivoRecordado.model.ts", tabla: "dispositivo_recordado" },
];

describe("the factor models name the tables their migration creates", () => {
  it("sets tableName explicitly on every one", async () => {
    // Sequelize's default pluralisation produced `ciudads`, `rols` and
    // `revicions` in this schema. Left to it, `factor_totp` becomes
    // `factor_totps` and nothing in this repo creates that table.
    for (const { fichero, tabla } of MODELOS) {
      const src = readFileSync(fichero, "utf8");
      expect(src, `${fichero} no fija tableName: "${tabla}"`).toContain(`tableName: "${tabla}"`);
    }
  });

  it("turns Sequelize's automatic timestamps off, because these tables have none", async () => {
    // The migration writes `created_at`, not `createdAt`/`updatedAt`. With
    // timestamps left on, every INSERT names two columns that do not exist.
    for (const { fichero } of MODELOS) {
      const src = readFileSync(fichero, "utf8");
      expect(src, `${fichero} deja los timestamps automáticos puestos`).toContain("timestamps: false");
    }
  });

  it("declares no column the migration does not create", async () => {
    // The brief's regex here was `/^\s{4}(\w+):\s*\{/gm` — exactly four
    // spaces. These models nest their columns inside `sequelize.define(`,
    // so they sit at six spaces; that regex matches zero columns and the
    // `toBeGreaterThan(3)` assertion below fails on every model, not just a
    // drifted one. `\s{4,}` (four or more) matches the real indentation
    // without opening the door to a false positive: `tableName:` and
    // `timestamps:` never carry a `{`, and `references:` appears inline
    // inside a column definition, never at the start of a line.
    for (const { fichero, tabla } of MODELOS) {
      const src = readFileSync(fichero, "utf8");
      const bloque = MIGRACION.slice(MIGRACION.indexOf(`"${tabla}"`));
      const declaradas = [...src.matchAll(/^\s{4,}(\w+):\s*\{/gm)].map((m) => m[1]);
      expect(declaradas.length, `${fichero} no declara ninguna columna`).toBeGreaterThan(3);
      for (const col of declaradas) {
        expect(bloque, `${fichero}: la columna "${col}" no existe en la migración`).toContain(
          `${col}:`,
        );
      }
    }
  });
});

describe("the two tables that gained columns declare them too", () => {
  it("usuario carries the grace deadline and the password date", () => {
    const src = readFileSync("src/models/usuario.model.ts", "utf8");
    expect(src).toContain("mfa_grace_until");
    expect(src).toContain("pass_changed_at");
  });

  it("sesion carries the state and the proof of a factor", () => {
    const src = readFileSync("src/models/sesion.model.ts", "utf8");
    expect(src).toContain("estado");
    expect(src).toContain("mfa_satisfied_at");
    expect(src).toContain("mfa_source");
  });
});
