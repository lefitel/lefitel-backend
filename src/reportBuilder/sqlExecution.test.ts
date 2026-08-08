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
