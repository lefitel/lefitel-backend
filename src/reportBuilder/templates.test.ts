// The six templates, held to the promise they make.
//
// A template is an example somebody presses to learn what this screen does, so
// a broken one teaches the wrong lesson twice: once about the report, and once
// about whether the tool works at all. They are also the only configurations in
// the product that nobody maintains by using them — a field renamed in the
// catalog breaks a template silently, and the first person to find out is a
// client pressing "Cobertura por ciudad".
//
// So this file asks four things of every template: that the builder can build
// it, that Postgres accepts what comes out, that every role which can open the
// screen gets all six intact, and that none of them carries a date that will
// stop being true.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sequelize } from "../database/sequelize.js";
import { buildQuery, buildCountQuery } from "./sqlBuilder.js";
import { pruneConfig } from "./prune.js";
import { TEMPLATES, templatesFor } from "./templates.js";
import type { FilterCondition } from "./types.js";
import type { Viewer } from "./viewer.js";

/** The three roles that hold `generador.ver`, as staff and as not. */
const ADMIN: Viewer = { role: 1, staff: true };
const CLIENTE: Viewer = { role: 3, staff: false };
const VIEWERS: [string, Viewer][] = [["administrador", ADMIN], ["cliente", CLIENTE]];

describe("every template is a report the builder can actually build", () => {
  for (const [who, viewer] of VIEWERS) {
    it(`builds all six for a ${who}`, () => {
      for (const template of TEMPLATES) {
        // Not wrapped in expect().not.toThrow(): the thrown message names the
        // path that broke, and that is the whole diagnostic.
        buildQuery(template.config, viewer);
        buildCountQuery(template.config, viewer);
      }
      expect(TEMPLATES).toHaveLength(6);
    });
  }

  it("gives every role the whole of every template", () => {
    // The point of the "nothing personal" rule. A template that loses a column
    // for the Cliente is worse than one that is not offered: it is an example
    // that quietly disagrees with the example somebody else was shown.
    for (const [who, viewer] of VIEWERS) {
      expect(templatesFor(viewer).map((t) => t.key), who)
        .toEqual(TEMPLATES.map((t) => t.key));
    }
  });

  it("keys are unique and stable-looking", () => {
    // The client keys its gallery on these. Two templates sharing one is a
    // React list with duplicate keys, which reconciles into the wrong card.
    const keys = TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9-]+$/);
  });

  it("every template says what it is for", () => {
    for (const template of TEMPLATES) {
      expect(template.name.length, template.key).toBeGreaterThan(0);
      // A description is what somebody chooses between six by. "Reporte de
      // eventos" beside "General de eventos" is a label repeated, not a reason.
      expect(template.description.length, template.key).toBeGreaterThan(30);
      expect(template.description, template.key).not.toContain(template.name);
    }
  });
});

describe("no template carries a date that will stop being true", () => {
  it("filters on no absolute date at all", () => {
    // There is no relative date operator — `between`, `gte`, `lte`, `isnull`,
    // `notnull` — so "las revisiones de este mes" can only be written as one
    // fixed month. It would go on calling itself "de este mes" for years. Where
    // recency matters these sort by date instead, which never expires.
    const looksLikeADate = (value: unknown): boolean =>
      value instanceof Date ||
      (typeof value === "string" && /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/.test(value));

    for (const template of TEMPLATES) {
      for (const condition of template.config.filters?.conditions ?? []) {
        const { value } = condition as FilterCondition;
        const values = Array.isArray(value) ? value : [value];
        for (const one of values) {
          expect(looksLikeADate(one), `${template.key} filtra por una fecha fija`).toBe(false);
        }
      }
    }
  });

  it("says «recientes» rather than naming a period it cannot honour", () => {
    for (const template of TEMPLATES) {
      const said = `${template.name} ${template.description}`.toLowerCase();
      expect(said, template.key).not.toMatch(/\bdel mes\b|\beste mes\b|\bdel año\b|\beste año\b/);
    }
  });
});

describe("a summary template groups everything it does not summarise", () => {
  it("leaves no bare column beside a grouping", () => {
    // The rule the server enforces and the screen refuses reports over. A
    // template that broke it would be an example that cannot be run, which is
    // caught by the build tests above — this names the reason instead of
    // leaving it as an unexplained throw.
    for (const template of TEMPLATES) {
      const grouped = new Set(template.config.groupBy ?? []);
      if (grouped.size === 0) continue;
      for (const column of template.config.columns) {
        expect(
          grouped.has(column.path) || column.agg !== undefined,
          `${template.key}: «${column.path}» ni agrupada ni resumida`,
        ).toBe(true);
      }
    }
  });
});

// ─── Against the database ────────────────────────────────────────────────────

const dbAvailable = await sequelize
  .authenticate()
  .then(() => true)
  .catch(() => false);

beforeAll(() => {
  if (!dbAvailable) {
    console.warn("\n  !! templates: sin base de datos. Nadie comprueba que las seis se ejecuten.\n");
  }
});

afterAll(async () => {
  if (dbAvailable) await sequelize.close();
});

describe.skipIf(!dbAvailable)("Postgres accepts all six", () => {
  const explain = async (sql: string, binds: unknown[]): Promise<string | null> => {
    try {
      await sequelize.query(`EXPLAIN ${sql}`, { bind: binds, logging: false });
      return null;
    } catch (error) {
      const parent = (error as { parent?: { message?: string } }).parent;
      return (parent?.message ?? (error as Error).message).split("\n")[0];
    }
  };

  it("plans every template, for every role, both as rows and as a count", async () => {
    // Building the SQL only proves the paths resolve. `ultimaRevision.evento.*`
    // and `SUM(text)` both built a string that reads perfectly and that
    // Postgres refuses; a template with one of those in it would save, list,
    // and answer 500 on every press forever.
    const broken: string[] = [];

    for (const [who, viewer] of VIEWERS) {
      for (const template of TEMPLATES) {
        const pruned = pruneConfig(template.config, viewer).config;
        const rows = buildQuery({ ...pruned, limit: 1 }, viewer);
        const count = buildCountQuery(pruned, viewer);
        for (const [what, built] of [["filas", rows], ["conteo", count]] as const) {
          const complaint = await explain(built.sql, built.binds);
          if (complaint) broken.push(`${template.key} / ${who} / ${what}: ${complaint}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
