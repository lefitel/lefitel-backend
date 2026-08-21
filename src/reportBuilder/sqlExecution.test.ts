// Does Postgres accept what the builder writes?
//
// Every other test here asserts on substrings of the generated SQL, which
// proves the string looks right and nothing more. Two whole classes of defect
// lived under that: `ultimaRevision.evento.*` joined against a column the
// LATERAL never projected, and aggregates skipped their type check for to-many
// paths and built `SUM(text)`. Both produced SQL that reads perfectly and that
// Postgres refuses — and because saving a report validates by building the same
// string, both saved cleanly and then answered 500 on every run, forever.
//
// EXPLAIN parses and plans without touching a row, so this sweeps the entire
// catalog in a second or two. It is the only test that hands generated SQL to a
// database on a path that does not depend on the data being there.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueryTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { buildQuery } from "./sqlBuilder.js";
import { buildCatalogView } from "./catalogView.js";
import { runReport, countReport } from "./execute.js";

const ADMIN = 1;

const dbAvailable = await sequelize
  .authenticate()
  .then(() => true)
  .catch(() => false);

beforeAll(() => {
  if (!dbAvailable) {
    console.warn(
      "\n  !! sqlExecution: sin base de datos. Nada comprueba que el SQL generado sea válido.\n",
    );
  }
});

afterAll(async () => {
  if (dbAvailable) await sequelize.close();
});

/** Plans the statement. Returns the database's complaint, or null if it parsed. */
async function explain(sql: string, binds: unknown[]): Promise<string | null> {
  try {
    await sequelize.query(`EXPLAIN ${sql}`, { bind: binds, logging: false });
    return null;
  } catch (error) {
    const parent = (error as { parent?: { message?: string } }).parent;
    return (parent?.message ?? (error as Error).message).split("\n")[0];
  }
}

const view = buildCatalogView(ADMIN);

describe.skipIf(!dbAvailable)("every advertised path produces SQL Postgres accepts", () => {
  it("plans a report for each field the picker offers", async () => {
    const broken: string[] = [];
    let checked = 0;

    for (const root of view.roots) {
      const columns = [
        ...root.fields.map((field) => ({ path: field.path })),
        // A to-many relation is offered only as an aggregate, so ask for it the
        // way the picker would rather than skipping it.
        ...root.aggregateOnly.map((relation) => ({ path: relation.path, agg: "count" as const })),
      ];

      for (const column of columns) {
        checked += 1;
        const { sql, binds } = buildQuery({ root: root.key, columns: [column], limit: 1 }, ADMIN);
        const complaint = await explain(sql, binds);
        if (complaint) broken.push(`${root.key} / ${column.path}: ${complaint}`);
      }
    }

    // A catalog that advertises nothing would pass every assertion below.
    expect(checked).toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });

  it("plans a summary for each aggregate a field advertises", async () => {
    // Two failures are possible here and both matter: the builder refusing a
    // combination the catalog offers — a click in the picker that can only end
    // in a 400 — and Postgres refusing SQL the builder was happy to write.
    const refused: string[] = [];
    const broken: string[] = [];
    let checked = 0;

    for (const root of view.roots) {
      for (const field of root.fields) {
        // Group by something that is not the column being summarised, or the
        // builder rightly objects to doing both to one column.
        const groupPath = root.fields.find((f) => !f.aggregate && f.path !== field.path)?.path;
        if (!groupPath) continue;

        for (const agg of field.aggregates ?? []) {
          checked += 1;
          const config = {
            root: root.key,
            columns: [{ path: groupPath }, { path: field.path, agg }],
            groupBy: [groupPath],
            limit: 1,
          };
          let sql: string;
          let binds: unknown[];
          try {
            ({ sql, binds } = buildQuery(config, ADMIN));
          } catch (error) {
            refused.push(`${root.key} / ${field.path} ${agg}: ${(error as Error).message}`);
            continue;
          }
          const complaint = await explain(sql, binds);
          if (complaint) broken.push(`${root.key} / ${field.path} ${agg}: ${complaint}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(100);
    expect(refused).toEqual([]);
    expect(broken).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)("archived records stay out of every root", () => {
  it("does not count the children of an archived event", async () => {
    // 138 archived events carry 404 revisions and 141 observations. They used
    // to be counted on those two roots — the roots the documentation claimed
    // excluded them — and to appear in the listing with every event column
    // blank, reading as missing data rather than as deletions.
    const totals: Record<string, number> = {};
    for (const root of ["evento", "revision", "eventoObs"]) {
      totals[root] = await countReport({ root, columns: [{ path: "id" }], limit: 1 }, ADMIN);
    }

    expect(totals).toEqual({ evento: 1376, revision: 7337, eventoObs: 1422 });
  });

  it("leaves no group of orphans behind", async () => {
    // Grouped by tramo, the archived events' revisions collected into a
    // ninetieth group keyed on null.
    const result = await runReport(
      {
        root: "revision",
        columns: [{ path: "evento.poste.tramo" }, { path: "id", agg: "count" }],
        groupBy: ["evento.poste.tramo"],
        limit: 500,
      },
      ADMIN,
    );

    expect(result.rows).toHaveLength(89);
    expect(result.rows.some((row) => row.c0 === null)).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("a calendar day means the same day to Postgres", () => {
  // The only test in the suite that compares the engine's answer to the truth
  // rather than to another string. Everything about the date boundary was
  // asserted on substrings, and the substring was right while the bound was
  // eight hours early: "los eventos del 17/01/2026" returned 63 where 4
  // occurred, and every report with a date range carried the same error in its
  // lower half. A filter is a claim about which rows belong; only rows can
  // check it.

  /** What the calendar says, read straight from the column in the report's zone. */
  async function trueCount(day: string): Promise<number> {
    const [row] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "eventos"
        WHERE "deletedAt" IS NULL AND ("date" AT TIME ZONE 'America/La_Paz')::date = $1::date`,
      { bind: [day], type: QueryTypes.SELECT, logging: false },
    );
    return Number(row.n);
  }

  it("counts a single day as that day, not as a window straddling two", async () => {
    // The days chosen are the ones that actually catch it: each has events in
    // the hours the broken bound swept in from the day before. On a quiet day
    // the two readings agree and the test would pass over the bug.
    const [busiest] = await sequelize.query<{ dia: string }>(
      `SELECT to_char(("date" AT TIME ZONE 'America/La_Paz')::date, 'YYYY-MM-DD') AS dia
         FROM "eventos" WHERE "deletedAt" IS NULL
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      { type: QueryTypes.SELECT, logging: false },
    );

    for (const day of [busiest.dia, "2026-01-17", "2025-11-15"]) {
      const engine = await countReport(
        {
          root: "evento",
          columns: [{ path: "id" }],
          filters: { op: "and", conditions: [{ path: "date", operator: "eq", value: day }] },
          limit: 1,
        },
        ADMIN,
      );
      expect(engine, day).toBe(await trueCount(day));
    }
  });

  /** Events on one side of `day`, read from the column in the report's zone. */
  async function trueCountBeside(day: string, side: ">=" | "<"): Promise<number> {
    const [row] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "eventos"
        WHERE "deletedAt" IS NULL AND ("date" AT TIME ZONE 'America/La_Paz')::date ${side} $1::date`,
      { bind: [day], type: QueryTypes.SELECT, logging: false },
    );
    return Number(row.n);
  }

  it("splits the set the same way from either side", async () => {
    // `gte` and `lt` over the same day have to partition the events exactly.
    // `lt` was four hours off, so thirty of them fell on both sides or on
    // neither. What sits outside the partition is the one event with no date at
    // all: a comparison against NULL is NULL, so it belongs to no side — which
    // is right, and is asserted here rather than left as an off-by-one nobody
    // can explain later.
    const day = "2026-01-17";
    const ask = (operator: "gte" | "lt") =>
      countReport(
        {
          root: "evento",
          columns: [{ path: "id" }],
          filters: { op: "and", conditions: [{ path: "date", operator, value: day }] },
          limit: 1,
        },
        ADMIN,
      );

    const [desde, antes, total] = await Promise.all([
      ask("gte"),
      ask("lt"),
      countReport({ root: "evento", columns: [{ path: "id" }], limit: 1 }, ADMIN),
    ]);
    const [sinFecha] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "eventos" WHERE "deletedAt" IS NULL AND "date" IS NULL`,
      { type: QueryTypes.SELECT, logging: false },
    );

    expect(desde).toBe(await trueCountBeside(day, ">="));
    expect(antes).toBe(await trueCountBeside(day, "<"));
    expect(desde + antes + Number(sinFecha.n)).toBe(total);
  });

  it("puts the boundary on the same instant whatever zone the session runs in", async () => {
    // The bug in one line. `$1::date AT TIME ZONE zone` resolves to the
    // overload that reads the date in the *session's* zone, so the same report
    // meant three different days on three different servers. The cast to
    // `timestamp` pins the other overload, and then the session cannot reach it.
    const instants = await sequelize.transaction(async (transaction) => {
      const seen: string[] = [];
      for (const zone of ["UTC", "America/La_Paz", "Asia/Tokyo"]) {
        await sequelize.query(`SET LOCAL TIME ZONE '${zone}'`, { transaction, logging: false });
        const [row] = await sequelize.query<{ t: Date }>(
          `SELECT (($1::date)::timestamp AT TIME ZONE 'America/La_Paz') AS t`,
          { bind: ["2026-01-17"], type: QueryTypes.SELECT, transaction, logging: false },
        );
        seen.push(new Date(row.t).toISOString());
      }
      return seen;
    });

    expect(new Set(instants).size).toBe(1);
    expect(instants[0]).toBe("2026-01-17T04:00:00.000Z");
  });
});
