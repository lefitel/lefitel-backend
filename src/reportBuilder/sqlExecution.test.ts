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
import { buildQuery, buildCountQuery } from "./sqlBuilder.js";
import { buildCatalogView } from "./catalogView.js";
import { catalog } from "./catalog.js";
import { runReport, countReport } from "./execute.js";
import type { Viewer } from "./viewer.js";

const ADMIN: Viewer = { role: 1, staff: true };

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

describe.skipIf(!dbAvailable)("the three roots that were missing", () => {
  it("gives one row per repair, not one per event that has one", async () => {
    // A repair was only reachable as `evento.solucion`, a `toOneLatest` — the
    // most recent one — so "what work was done in March" came out as one row
    // per event whose latest repair fell in March. Five events carry two
    // repairs, and those five second repairs could not be shown at all.
    const total = await countReport(
      { root: "solucion", columns: [{ path: "id" }], limit: 1 },
      ADMIN,
    );
    const [row] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "solucions" s
         JOIN "eventos" e ON e."id" = s."id_evento" AND e."deletedAt" IS NULL
        WHERE s."deletedAt" IS NULL`,
      { type: QueryTypes.SELECT, logging: false },
    );

    expect(total).toBe(Number(row.n));

    // And it is more than the number of events that have one, which is the
    // whole point: the difference is the repairs that were invisible.
    const [conSolucion] = await sequelize.query<{ n: number }>(
      `SELECT count(DISTINCT s."id_evento")::int AS n FROM "solucions" s
         JOIN "eventos" e ON e."id" = s."id_evento" AND e."deletedAt" IS NULL
        WHERE s."deletedAt" IS NULL`,
      { type: QueryTypes.SELECT, logging: false },
    );
    expect(total).toBeGreaterThan(Number(conSolucion.n));
  });

  it("counts a city's poles and events the way a hand-written query does", async () => {
    const built = buildQuery(
      {
        root: "ciudad",
        columns: [
          { path: "name" },
          { path: "numPostes" },
          { path: "numEventos" },
          { path: "numPendientes" },
        ],
        sort: [{ path: "numEventos", dir: "desc" }],
        limit: 5,
      },
      ADMIN,
    );
    const rows = await sequelize.query<Record<string, unknown>>(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      logging: false,
    });

    const [key, postes, eventos, pendientes] = built.columns.map((c) => c.key);
    for (const row of rows) {
      const [truth] = await sequelize.query<{ postes: number; eventos: number; pend: number }>(
        `SELECT
           (SELECT count(*)::int FROM "postes" p WHERE p."deletedAt" IS NULL
              AND (p."id_ciudadA" = c."id" OR p."id_ciudadB" = c."id")) AS postes,
           (SELECT count(*)::int FROM "eventos" e
              JOIN "postes" p ON p."id" = e."id_poste" AND p."deletedAt" IS NULL
             WHERE e."deletedAt" IS NULL
               AND (p."id_ciudadA" = c."id" OR p."id_ciudadB" = c."id")) AS eventos,
           (SELECT count(*)::int FROM "eventos" e
              JOIN "postes" p ON p."id" = e."id_poste" AND p."deletedAt" IS NULL
             WHERE e."deletedAt" IS NULL AND e."state" IS NOT TRUE
               AND (p."id_ciudadA" = c."id" OR p."id_ciudadB" = c."id")) AS pend
           FROM "ciudads" c WHERE c."name" = $1 AND c."deletedAt" IS NULL LIMIT 1`,
        { bind: [row[key]], type: QueryTypes.SELECT, logging: false },
      );

      expect(Number(row[postes]), `postes de ${String(row[key])}`).toBe(truth.postes);
      expect(Number(row[eventos]), `eventos de ${String(row[key])}`).toBe(truth.eventos);
      expect(Number(row[pendientes]), `pendientes de ${String(row[key])}`).toBe(truth.pend);
    }
  });

  it("shows the cities that have nothing, which is why the root exists", async () => {
    // Grouping events by city can only ever show the cities that have events.
    // The thirteen with no pole at all are invisible from every other root, and
    // "where have we not been yet" is a question somebody asks.
    const built = buildQuery(
      {
        root: "ciudad",
        columns: [{ path: "name" }, { path: "numPostes" }],
        filters: { op: "and", conditions: [{ path: "numPostes", operator: "eq", value: 0 }] },
        limit: 200,
      },
      ADMIN,
    );
    const rows = await sequelize.query<Record<string, unknown>>(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      logging: false,
    });
    const [truth] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ciudads" c WHERE c."deletedAt" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "postes" p WHERE p."deletedAt" IS NULL
           AND (p."id_ciudadA" = c."id" OR p."id_ciudadB" = c."id"))`,
      { type: QueryTypes.SELECT, logging: false },
    );

    expect(rows).toHaveLength(Number(truth.n));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("does not add up across cities, and says so in the header", async () => {
    // A pole stands on a tramo and belongs to both of its cities, so the column
    // counts it twice. That is right per row and false as a total, which is
    // exactly the shape of defect two audits found — a number that reads
    // perfectly under an honest header. The header is the only defence, so the
    // label has to carry the unit, and this pins it.
    const built = buildQuery(
      { root: "ciudad", columns: [{ path: "numPostes" }], limit: 200 },
      ADMIN,
    );
    expect(built.columns[0].label).toContain("tramos");

    const rows = await sequelize.query<Record<string, unknown>>(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      logging: false,
    });
    const suma = rows.reduce((total, row) => total + Number(row[built.columns[0].key]), 0);
    const [postes] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "postes" WHERE "deletedAt" IS NULL`,
      { type: QueryTypes.SELECT, logging: false },
    );

    // Nearly twice: every pole counts at both ends, except the two whose two
    // ends are the same city. Asserted rather than left as a surprise.
    expect(suma).toBeGreaterThan(Number(postes.n));
    expect(suma).toBeLessThanOrEqual(Number(postes.n) * 2);
  });

  it("counts what each person registered, and only what the schema records", async () => {
    // `revicions` and `solucions` carry no `id_usuario`, so an inspection and a
    // repair have no recorded author. This root can only answer for events and
    // poles, and that limit belongs in a test so nobody reads more into the
    // report than it says.
    const built = buildQuery(
      {
        root: "usuario",
        columns: [{ path: "user" }, { path: "numEventos" }, { path: "numPostes" }],
        limit: 50,
      },
      ADMIN,
    );
    const rows = await sequelize.query<Record<string, unknown>>(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      logging: false,
    });
    const [eventos] = built.columns.slice(1).map((c) => c.key);
    const suma = rows.reduce((total, row) => total + Number(row[eventos] ?? 0), 0);

    // One event has exactly one author, so unlike the city columns this one
    // does add up — but only over the events whose author still exists. Two
    // gaps sit between this total and the 1.376 events, and both belong in a
    // test rather than in somebody's afternoon:
    //
    //   211 events carry no `id_usuario` at all (imported data), and
    //    70 more were registered by one of the six archived accounts, which a
    //       per-user report cannot show because the account is not a row.
    //
    // So a report of "events per person" accounts for 1.095 of 1.376. Anyone
    // summing the column and comparing it against the event count needs to know
    // that, and the number is asserted so a change in it is noticed.
    const [truth] = await sequelize.query<{ vivos: number; total: number; huerfanos: number }>(
      `SELECT
         (SELECT count(*)::int FROM "eventos" e
            JOIN "usuarios" u ON u."id" = e."id_usuario" AND u."deletedAt" IS NULL
           WHERE e."deletedAt" IS NULL) AS vivos,
         (SELECT count(*)::int FROM "eventos" WHERE "deletedAt" IS NULL) AS total,
         (SELECT count(*)::int FROM "eventos" WHERE "deletedAt" IS NULL
            AND "id_usuario" IS NULL) AS huerfanos`,
      { type: QueryTypes.SELECT, logging: false },
    );
    expect(suma).toBe(Number(truth.vivos));
    expect(Number(truth.vivos)).toBeLessThan(Number(truth.total));
    expect(Number(truth.huerfanos)).toBeGreaterThan(0);

    // Inspections can be asked about here now, and the same warning applies
    // twice over. `numRevisiones` sums to the rows the authorship backfill
    // could name — everything since the bitácora began and nothing before it —
    // so it ranks people over five months of a two-year history. The three
    // numbers are asserted together because the middle one is the one that
    // makes the first one readable.
    const insp = buildQuery(
      { root: "usuario", columns: [{ path: "name" }, { path: "numRevisiones" }] },
      ADMIN,
    );
    const inspRows = await sequelize.query<Record<string, unknown>>(insp.sql, {
      bind: insp.binds, type: QueryTypes.SELECT, logging: false,
    });
    const [inspCol] = insp.columns.slice(1).map((c) => c.key);
    const sumaInsp = inspRows.reduce((t, row) => t + Number(row[inspCol] ?? 0), 0);

    const [rev] = await sequelize.query<{ atribuidas: number; en_reporte: number }>(
      `SELECT
         (SELECT count(*)::int FROM "revicions" r
            JOIN "usuarios" u ON u."id" = r."id_usuario" AND u."deletedAt" IS NULL
           WHERE r."deletedAt" IS NULL
             AND EXISTS (SELECT 1 FROM "eventos" e
                          WHERE e."id" = r."id_evento" AND e."deletedAt" IS NULL)) AS atribuidas,
         (SELECT count(*)::int FROM "revicions" r
           WHERE r."deletedAt" IS NULL
             AND EXISTS (SELECT 1 FROM "eventos" e
                          WHERE e."id" = r."id_evento" AND e."deletedAt" IS NULL)) AS en_reporte`,
      { type: QueryTypes.SELECT, logging: false },
    );
    expect(sumaInsp).toBe(Number(rev.atribuidas));
    // The column is a fraction of the work, not the work. If this ever stops
    // being true it means somebody found a way to attribute the rest, and this
    // assertion is where they should come and say so.
    expect(Number(rev.atribuidas)).toBeLessThan(Number(rev.en_reporte));
  });
});

describe.skipIf(!dbAvailable)("an unknown author hides no work", () => {
  it("keeps every inspection in the report, authored or not", async () => {
    // The trap this test exists for: marking `revision.usuario` as `required`
    // in the catalog reads like a tidy-up and is not. `required` emits an
    // unconditional EXISTS on the FK — see requiredParentGuards — so a null
    // `id_usuario` matches nothing and the row leaves the report, whether or
    // not the report ever mentions the author. Six thousand inspections would
    // disappear from every total, quietly, and the remaining table would look
    // completely reasonable.
    // Counted with buildCountQuery rather than by wrapping buildQuery: the
    // latter carries the MAX_ROWS limit, so wrapping it counts the cap and this
    // test passed at 500 whatever the truth was. The count path is the one that
    // has to agree with the table anyway.
    const built = buildCountQuery(
      { root: "revision", columns: [{ path: "id" }, { path: "usuario.name" }] },
      ADMIN,
    );
    const [{ total: filas }] = await sequelize.query<{ total: number }>(built.sql, {
      bind: built.binds, type: QueryTypes.SELECT, logging: false,
    });

    const [truth] = await sequelize.query<{ total: number; sin_autor: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE r."id_usuario" IS NULL)::int AS sin_autor
         FROM "revicions" r
        WHERE r."deletedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "eventos" e
                       WHERE e."id" = r."id_evento" AND e."deletedAt" IS NULL)`,
      { type: QueryTypes.SELECT, logging: false },
    );

    expect(filas).toBe(Number(truth.total));
    // And the rows without an author are the majority, so this is not a
    // hypothetical being guarded against.
    expect(Number(truth.sin_autor)).toBeGreaterThan(Number(truth.total) / 2);
  });

  it("keeps every repair too", async () => {
    const built = buildCountQuery(
      { root: "solucion", columns: [{ path: "id" }, { path: "usuario.name" }] },
      ADMIN,
    );
    const [{ total: filas }] = await sequelize.query<{ total: number }>(built.sql, {
      bind: built.binds, type: QueryTypes.SELECT, logging: false,
    });
    const [truth] = await sequelize.query<{ total: number; sin_autor: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE s."id_usuario" IS NULL)::int AS sin_autor
         FROM "solucions" s
        WHERE s."deletedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "eventos" e
                       WHERE e."id" = s."id_evento" AND e."deletedAt" IS NULL)`,
      { type: QueryTypes.SELECT, logging: false },
    );
    expect(filas).toBe(Number(truth.total));
    expect(Number(truth.sin_autor)).toBeGreaterThan(0);
  });
});

describe.skipIf(!dbAvailable)("a value nobody knows stays unknown", () => {
  it("does not report zero days open for an event with no date", async () => {
    // `GREATEST` ignores nulls instead of propagating them, so `GREATEST(0,
    // NULL)` is 0: an event with no date read as "abierto hace 0 días", stated
    // as confidently as the real figures. The data has one dateless event and
    // it is resolved, so the CASE hides the defect — the assertion is made
    // against a row built for the purpose instead of against luck.
    const [row] = await sequelize.query<{ dias: number | null }>(
      `SELECT CASE WHEN e."state" IS NOT TRUE AND e."date" IS NOT NULL
                   THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - e."date")) / 86400))::int END
                 AS dias
         FROM (SELECT false AS "state", NULL::timestamptz AS "date") e`,
      { type: QueryTypes.SELECT, logging: false },
    );
    expect(row.dias).toBeNull();

    // The shape it replaces, kept so the reason is visible: this is what the
    // column used to answer for that same row.
    const [before] = await sequelize.query<{ dias: number | null }>(
      `SELECT CASE WHEN e."state" IS NOT TRUE
                   THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - e."date")) / 86400))::int END
                 AS dias
         FROM (SELECT false AS "state", NULL::timestamptz AS "date") e`,
      { type: QueryTypes.SELECT, logging: false },
    );
    expect(before.dias).toBe(0);
  });

  it("keeps the catalog's expression and this test in step", async () => {
    // The assertion above is written against a hand-made row, so it would keep
    // passing if the catalog changed underneath it. This runs the real column
    // over the real table and only asks that no pending event without a date
    // reports a number — which is the property, whatever the SQL becomes.
    const rows = await sequelize.query<{ dias: number | null }>(
      `SELECT ${catalog.entities.evento.calculated!.diasAbierto.sql("e", () => "e")} AS dias
         FROM "eventos" e
        WHERE e."deletedAt" IS NULL AND e."date" IS NULL AND e."state" IS NOT TRUE`,
      { type: QueryTypes.SELECT, logging: false },
    );
    for (const row of rows) expect(row.dias).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("what the builder binds is what Postgres can read", () => {
  it("executes the shapes an <input> produces, instead of answering 22P02", async () => {
    // The only test that proves the point end to end: the builder approved
    // "1e5" by coercing it and then bound the text, so the database — not the
    // validation — had the last word, and its word was a 500. Each of these
    // used to reach Postgres as text against an integer column.
    const shapes: [string, unknown][] = [
      ["id", "1e5"],
      ["id", "7."],
      ["id", " 42 "],
      ["criticidad", "3.0"],
      ["state", "false"],
      ["poste.lat", "-17.78"],
      ["date", "2026-01-17"],
      ["date", "2026-01-17T05:00:00Z"],
    ];

    const broken: string[] = [];
    for (const [path, value] of shapes) {
      try {
        await countReport(
          {
            root: "evento",
            columns: [{ path: "id" }],
            filters: { op: "and", conditions: [{ path, operator: "eq", value }] },
            limit: 1,
          },
          ADMIN,
        );
      } catch (error) {
        const parent = (error as { parent?: { code?: string; message?: string } }).parent;
        broken.push(`${path} = ${JSON.stringify(value)} → ${parent?.code ?? ""} ${parent?.message ?? (error as Error).message}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it("lists every value of a list as a value, not as one text blob", async () => {
    // `= ANY($1)` with a mixed list used to bind ["1","2"] against an integer
    // column. The count is asserted against the same question asked by hand,
    // so a list that binds but matches nothing still fails here.
    const total = await countReport(
      {
        root: "evento",
        columns: [{ path: "id" }],
        filters: { op: "and", conditions: [{ path: "id", operator: "in", value: ["1", 2, " 3 "] }] },
        limit: 1,
      },
      ADMIN,
    );
    const [row] = await sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "eventos" WHERE "deletedAt" IS NULL AND "id" IN (1,2,3)`,
      { type: QueryTypes.SELECT, logging: false },
    );

    expect(total).toBe(Number(row.n));
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
    // The day is chosen because it *discriminates*, not because it is busy. On
    // a quiet day — or on any day with nothing in the four hours the broken
    // bound swept in from the evening before — both readings agree and the test
    // would pass straight over the bug. This asks the database for a day where
    // they disagree, so the test keeps its teeth on data that is not this data.
    const [worst] = await sequelize.query<{ dia: string }>(
      `SELECT to_char(("date" AT TIME ZONE 'America/La_Paz')::date, 'YYYY-MM-DD') AS dia,
              count(*) FILTER (
                WHERE "date" >= (("date" AT TIME ZONE 'America/La_Paz')::date - interval '4 hours')
                  AND "date" <  ("date" AT TIME ZONE 'America/La_Paz')::date
              ) AS arrastradas
         FROM "eventos" WHERE "deletedAt" IS NULL AND "date" IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      { type: QueryTypes.SELECT, logging: false },
    );

    // The two hardcoded days are facts about this database and are kept because
    // they are the measured ones: 4 events against 63 under the old bound, and
    // 23 against 53. `worst` is what keeps the test honest anywhere else.
    for (const day of [worst.dia, "2026-01-17", "2025-11-15"]) {
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

  it("returns the same rows whatever zone the session runs in", async () => {
    // The bug in one line. `$1::date AT TIME ZONE zone` resolves to the overload
    // that reads the date as an instant in the *session's* zone, so the same
    // saved report meant three different days on three different servers: 4
    // events in La Paz, 63 in UTC, 64 in Tokyo.
    //
    // Through `buildQuery` and its own binds, not a hand-written literal: the
    // first version of this test asserted a property of Postgres and would have
    // stayed green with the builder reverted, which is the substring mistake
    // one level further out.
    const { sql, binds } = buildQuery(
      {
        root: "evento",
        columns: [{ path: "id" }],
        filters: { op: "and", conditions: [{ path: "date", operator: "eq", value: "2026-01-17" }] },
        limit: 500,
      },
      ADMIN,
    );

    const counts = await sequelize.transaction(async (transaction) => {
      const seen: number[] = [];
      for (const zone of ["UTC", "America/La_Paz", "Asia/Tokyo"]) {
        await sequelize.query(`SET LOCAL TIME ZONE '${zone}'`, { transaction, logging: false });
        const rows = await sequelize.query<Record<string, unknown>>(sql, {
          bind: binds,
          type: QueryTypes.SELECT,
          transaction,
          logging: false,
        });
        seen.push(rows.length);
      }
      return seen;
    });

    expect(new Set(counts).size, `por zona: ${counts.join(", ")}`).toBe(1);
    expect(counts[0]).toBe(await trueCount("2026-01-17"));
  });
});
