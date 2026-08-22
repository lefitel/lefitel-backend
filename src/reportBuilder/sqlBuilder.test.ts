import { describe, it, expect } from "vitest";
import { buildQuery, buildCountQuery } from "./sqlBuilder.js";
import { catalog, MAX_ROWS } from "./catalog.js";
import { buildCatalogView } from "./catalogView.js";
import {
  ReportConfigError,
  type AggFn,
  type Operator,
  type ReportConfig,
} from "./types.js";
import type { Viewer } from "./viewer.js";

// The viewer, not a role number: field visibility is now a capability the
// request resolves once, and these are the two answers it can give.
const ADMIN: Viewer = { role: 1, staff: true };
const OPERATIVO: Viewer = { role: 3, staff: false };

const base = (over: Partial<ReportConfig> = {}): ReportConfig => ({
  root: "evento",
  columns: [{ path: "description" }],
  ...over,
});

describe("buildQuery — shape", () => {
  it("selects from the physical root table", () => {
    const { sql } = buildQuery(base(), ADMIN);
    expect(sql).toContain('FROM "eventos" t0');
  });

  it("applies the paranoid guard on the root", () => {
    const { sql } = buildQuery(base(), ADMIN);
    expect(sql).toContain('t0."deletedAt" IS NULL');
  });

  it("joins to-one relations and guards them too", () => {
    const { sql } = buildQuery(base({ columns: [{ path: "poste.name" }] }), ADMIN);
    expect(sql).toContain('LEFT JOIN "postes" t1 ON t1."id" = t0."id_poste"');
    expect(sql).toContain('t1."deletedAt" IS NULL');
  });

  it("reuses one join for columns sharing a prefix", () => {
    const { sql } = buildQuery(
      base({ columns: [{ path: "poste.name" }, { path: "poste.lat" }, { path: "poste.lng" }] }),
      ADMIN,
    );
    expect(sql.match(/LEFT JOIN "postes"/g)).toHaveLength(1);
  });

  it("chains relations up to three hops", () => {
    const { sql } = buildQuery(
      { root: "revision", columns: [{ path: "evento.poste.ciudadA.name" }] },
      ADMIN,
    );
    expect(sql).toContain('FROM "revicions" t0');
    expect(sql).toContain('LEFT JOIN "eventos"');
    expect(sql).toContain('LEFT JOIN "postes"');
    expect(sql).toContain('LEFT JOIN "ciudads"');
  });

  it("omits the deletedAt guard for tables that lack the column", () => {
    // `rols` is not paranoid; adding the guard would break the query.
    const { sql } = buildQuery(base({ columns: [{ path: "usuario.rol.name" }] }), ADMIN);
    const rolJoin = sql.split("\n").find((line) => line.includes('LEFT JOIN "rols"'));
    expect(rolJoin).toBeDefined();
    expect(rolJoin).not.toContain("deletedAt");
  });

  it("resolves toOneLatest with LATERAL instead of a plain join", () => {
    const { sql } = buildQuery(base({ columns: [{ path: "solucion.description" }] }), ADMIN);
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain('ORDER BY x."date" DESC NULLS LAST, x."id" DESC LIMIT 1');
    // Explicit projection rather than SELECT *, so columns outside the catalog
    // never enter the query.
    expect(sql).not.toContain("SELECT * FROM");
  });
});

describe("buildQuery — grain rule", () => {
  it("rejects a to-many field without an aggregate", () => {
    expect(() => buildQuery(base({ columns: [{ path: "revisiones.date" }] }), ADMIN))
      .toThrow(ReportConfigError);
  });

  it("resolves a to-many aggregate as a correlated subquery, not a join", () => {
    const { sql } = buildQuery(
      base({ columns: [{ path: "revisiones.date", agg: "max" }] }),
      ADMIN,
    );
    expect(sql).toContain('SELECT MAX(s."date") FROM "revicions" s');
    expect(sql).toContain('s."id_evento" = t0."id"');
    expect(sql).not.toContain('LEFT JOIN "revicions"');
  });

  it("counts a to-many relation with no field", () => {
    const { sql } = buildQuery(base({ columns: [{ path: "revisiones", agg: "count" }] }), ADMIN);
    expect(sql).toContain('SELECT COUNT(*) FROM "revicions" s');
  });

  it("rejects navigating through a to-many relation", () => {
    expect(() =>
      buildQuery({ root: "poste", columns: [{ path: "eventos.poste.name" }] }, ADMIN),
    ).toThrow(ReportConfigError);
  });
});

describe("buildQuery — summary mode", () => {
  const summary = (over: Partial<ReportConfig> = {}): ReportConfig => ({
    root: "poste",
    columns: [{ path: "tramo" }, { path: "numPendientes", agg: "sum" }],
    groupBy: ["tramo"],
    ...over,
  });

  it("emits GROUP BY for the grouped expression", () => {
    const { sql } = buildQuery(summary(), ADMIN);
    expect(sql).toContain("GROUP BY");
  });

  it("wraps non-grouped columns in their aggregate", () => {
    const { sql } = buildQuery(summary(), ADMIN);
    expect(sql).toContain("SUM(");
  });

  it("rejects a bare column when the report is grouped", () => {
    expect(() =>
      buildQuery(summary({ columns: [{ path: "tramo" }, { path: "name" }] }), ADMIN),
    ).toThrow(/necesita un resumen/);
  });

  it("rejects an aggregate when the report is not grouped", () => {
    expect(() =>
      buildQuery({ root: "poste", columns: [{ path: "lat", agg: "avg" }] }, ADMIN),
    ).toThrow(/no está agrupado/);
  });
});

describe("buildQuery — filters and binds", () => {
  it("never inlines a filter value into the SQL", () => {
    const { sql, binds } = buildQuery(
      base({
        filters: {
          op: "and",
          conditions: [{ path: "description", operator: "like", value: "poste roto" }],
        },
      }),
      ADMIN,
    );
    expect(sql).not.toContain("poste roto");
    expect(binds).toContain("%poste roto%");
  });

  it("covers the whole final day of a date range", () => {
    // Columns are `timestamp with time zone`; a plain BETWEEN against a bare
    // date silently dropped every row of the last day (74 of 1079 measured).
    const { sql, binds } = buildQuery(
      base({
        filters: {
          op: "and",
          conditions: [{ path: "date", operator: "between", value: ["2026-01-01", "2026-06-30"] }],
        },
      }),
      ADMIN,
    );
    expect(sql).toMatch(
      />= \(\(\$\d+::date\)::timestamp AT TIME ZONE 'America\/La_Paz'\) AND .* < \(\(\$\d+::date \+ interval '1 day'\)::timestamp AT TIME ZONE 'America\/La_Paz'\)/,
    );
    expect(binds).toContain("2026-01-01");
    expect(binds).toContain("2026-06-30");
  });

  it("reads a bare date in the zone the report is read in, not the session's", () => {
    // The columns are `timestamp with time zone` and the session runs in UTC,
    // so a bare date used to mean a UTC day while every rendered cell showed a
    // Bolivian one. 362 of 1.376 events — 26% — fell on different days under
    // the two readings.
    const { sql } = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "eq", value: "2024-05-23" }] } }),
      ADMIN,
    );

    // The cast is the assertion. This test used to check only that the string
    // "AT TIME ZONE 'America/La_Paz'" appeared — which it did, while the bound
    // still resolved in the session's zone, because a bare `date` reaches the
    // other overload of the operator. It passed for months over a filter that
    // returned 63 events for a day that had 4. Naming the zone is not the same
    // as reading it there.
    expect(sql).toMatch(/\(\(\$\d+::date\)::timestamp AT TIME ZONE 'America\/La_Paz'\)/);
    // No bound may reach `AT TIME ZONE` as a bare date, in any operator.
    expect(sql).not.toMatch(/\$\d+::date AT TIME ZONE/);
    // The column stays bare so an index on it still applies; only the bounds
    // are converted.
    expect(sql).not.toMatch(/t0\."date" AT TIME ZONE/);
  });

  it("compares a bound that carries a time as the instant it is", () => {
    const { sql } = buildQuery(
      base({
        filters: {
          op: "and",
          conditions: [
            { path: "date", operator: "between", value: ["2026-01-01", "2026-06-30T12:00:00Z"] },
          ],
        },
      }),
      ADMIN,
    );

    // Only the bare lower bound becomes a day boundary. Widening an instant the
    // user wrote to the second would move the edge they asked for.
    expect(sql).toMatch(/<= \$\d+/);
    expect(sql).not.toContain("interval '1 day'");
  });

  it("treats lte and gt on a bare date as whole days", () => {
    const lte = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "lte", value: "2026-06-30" }] } }),
      ADMIN,
    ).sql;
    expect(lte).toMatch(
      /< \(\(\$\d+::date \+ interval '1 day'\)::timestamp AT TIME ZONE 'America\/La_Paz'\)/,
    );

    const gt = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "gt", value: "2026-06-30" }] } }),
      ADMIN,
    ).sql;
    expect(gt).toMatch(
      />= \(\(\$\d+::date \+ interval '1 day'\)::timestamp AT TIME ZONE 'America\/La_Paz'\)/,
    );
  });

  it("makes neq on a bare date the exact complement of eq", () => {
    // `eq` covered the whole day and `neq` compared a single instant, so the
    // two did not partition the set: "distinta del 24 de mayo" returned all
    // 1.376 events, the six of that day included.
    const { sql } = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "neq", value: "2024-05-24" }] } }),
      ADMIN,
    );

    expect(sql).toMatch(/t0\."date" IS NULL OR .* < \(\(\$\d+::date\)::timestamp AT TIME ZONE/);
    expect(sql).toMatch(/OR .* >= \(\(\$\d+::date \+ interval '1 day'\)::timestamp AT TIME ZONE/);
  });

  it("counts filters across the whole report, not one group at a time", () => {
    // The cap said "el reporte tiene demasiados filtros" and was applied to
    // each group separately, so a hundred groups of a hundred conditions passed
    // cleanly: ten thousand conditions and four thousand correlated subqueries
    // in a body small enough that nothing else objected.
    const grupo = (n: number) => ({
      op: "and" as const,
      conditions: Array.from({ length: n }, () => ({
        path: "description", operator: "like" as const, value: "x",
      })),
    });

    expect(() =>
      buildQuery(
        base({ filters: { op: "and", conditions: [grupo(60), grupo(60)] } }),
        ADMIN,
      ),
    ).toThrow(/demasiados filtros/);

    // And a report inside the cap still builds, groups included.
    expect(() =>
      buildQuery(
        base({ filters: { op: "and", conditions: [grupo(40), grupo(40)] } }),
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("refuses an offset no page could ever have", () => {
    // 1e21 is finite, bound as 1e+21, and Postgres refuses it as an invalid
    // bigint — which the error handler reads as a server fault, so a caller
    // mistake came back as a 500 with a line in the error log.
    const { binds } = buildQuery(base({ offset: 1e21 }), ADMIN);
    expect(Number(binds[binds.length - 1])).toBeLessThanOrEqual(MAX_ROWS * 1000);
  });

  it("refuses a value the column cannot hold, instead of letting Postgres refuse it", () => {
    // These are the nine shapes that used to build clean SQL and come back as
    // 22P02 / 22007 / 22003 — a 500 that reads as "the server is broken".
    // Worse than the error: saving a report validates by building this same
    // SQL, so every one of them saved successfully and then failed on every
    // run, for its author and for anyone it was shared with.
    const rejected: [string, unknown][] = [
      ["id", {}],
      ["id", [1, 2]],
      ["id", "no-soy-numero"],
      ["id", ""],
      ["id", Number.NaN],
      ["id", Number.POSITIVE_INFINITY],
      ["id", "99999999999999999999"],
      ["date", "no-es-fecha"],
      ["state", "si"],
      ["description", 7],
    ];

    for (const [path, value] of rejected) {
      expect(
        () =>
          buildQuery(
            base({ filters: { op: "and", conditions: [{ path, operator: "eq", value }] } }),
            ADMIN,
          ),
        `${path} = ${JSON.stringify(value)}`,
      ).toThrow(ReportConfigError);
    }
  });

  it("checks both ends of a range and every entry of a list", () => {
    // The wrappers were shape-checked and their contents were not, so one bad
    // entry among good ones still reached the database.
    expect(() =>
      buildQuery(
        base({
          filters: {
            op: "and",
            conditions: [{ path: "id", operator: "between", value: [1, "a"] }],
          },
        }),
        ADMIN,
      ),
    ).toThrow(ReportConfigError);

    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "id", operator: "in", value: [1, 2, "x"] }] },
        }),
        ADMIN,
      ),
    ).toThrow(ReportConfigError);
  });

  it("caps how long a single filter value may be", () => {
    // Unbounded, a filter value was a free megabyte per condition inside a
    // body the server otherwise accepts.
    expect(() =>
      buildQuery(
        base({
          filters: {
            op: "and",
            conditions: [{ path: "description", operator: "like", value: "x".repeat(201) }],
          },
        }),
        ADMIN,
      ),
    ).toThrow(/demasiado largo/);
  });

  it("still accepts the shapes people actually send", () => {
    // A validation that refuses honest input is its own defect: numbers arrive
    // from an <input> as text, booleans as "true"/"false", dates as bare days.
    const fine: [string, unknown][] = [
      ["id", 7],
      ["id", "7"],
      ["id", " 7 "],
      ["state", true],
      ["state", "false"],
      ["date", "2026-01-17"],
      ["date", "2026-01-17T12:00:00Z"],
      ["description", "poste roto"],
    ];

    for (const [path, value] of fine) {
      expect(
        () =>
          buildQuery(
            base({ filters: { op: "and", conditions: [{ path, operator: "eq", value }] } }),
            ADMIN,
          ),
        `${path} = ${JSON.stringify(value)}`,
      ).not.toThrow();
    }
  });

  it("binds the value it validated, not the text it was handed", () => {
    // The defect this closes: the check coerced the text to a number to judge
    // it and then bound the text. So "1e5" was approved *as a number* and sent
    // *as text*, and Postgres answered 22P02 on an integer column — the exact
    // 500 the check exists to prevent, produced by the check passing.
    const cases: [unknown, number][] = [
      ["1e5", 100_000],
      ["7.", 7],
      [" 42 ", 42],
      ["3.0", 3],
      ["-8", -8],
    ];

    for (const [sent, bound] of cases) {
      const { binds } = buildQuery(
        base({ filters: { op: "and", conditions: [{ path: "id", operator: "eq", value: sent }] } }),
        ADMIN,
      );
      expect(binds, `${JSON.stringify(sent)} debe ligarse como número`).toContain(bound);
      expect(binds).not.toContain(sent);
    }
  });

  it("normalises a boolean typed as text into a boolean", () => {
    const { binds } = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "state", operator: "eq", value: "false" }] } }),
      ADMIN,
    );
    expect(binds).toContain(false);
    expect(binds).not.toContain("false");
  });

  it("refuses a decimal on an integer column, and allows one where the column has decimals", () => {
    // Reachable by typing: "Criticidad ≤ 2,5" in the filter box. The catalog is
    // what knows the difference — every number in it is an integer column
    // except the coordinates — so this is the only place the question can be
    // answered before Postgres answers it with a 500.
    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "criticidad", operator: "lte", value: 2.5 }] },
        }),
        ADMIN,
      ),
    ).toThrow(/enteros/);

    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "poste.lat", operator: "gte", value: -17.78 }] },
        }),
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("refuses a day that does not exist instead of rolling it into the next month", () => {
    // `new Date("2026-02-30")` is the 2nd of March. Nothing failed: the report
    // answered about a day nobody asked about, under a header naming the day
    // they did ask about. The other three are shapes JavaScript accepts by
    // guessing — a bare year means the 1st of January, and 01/17/2026 is read
    // in US order.
    for (const value of ["2026-02-30", "2026", "01/17/2026", "2026-13-01", "17/01/2026"]) {
      expect(
        () =>
          buildQuery(
            base({ filters: { op: "and", conditions: [{ path: "date", operator: "eq", value }] } }),
            ADMIN,
          ),
        `fecha ${value}`,
      ).toThrow(ReportConfigError);
    }
  });

  it("refuses an empty value inside a list or a range", () => {
    // `= ANY` and `BETWEEN` both propagate null, so one empty box among five
    // values built valid SQL, returned zero rows, and said nothing about why.
    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "id", operator: "in", value: [1, null, 3] }] },
        }),
        ADMIN,
      ),
    ).toThrow(/vacío/);

    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "id", operator: "between", value: [1, null] }] },
        }),
        ADMIN,
      ),
    ).toThrow(/vacío/);
  });

  it("never hands a bare date to AT TIME ZONE, whichever operator asked", () => {
    // The general net under the specific one. `date AT TIME ZONE zone` has two
    // readings and Postgres picks the wrong one for a bare date, so the rule is
    // not "some operators cast" but "no bound ever reaches that operator
    // uncast". Written as a sweep because the two that were broken — gte and lt
    // — were broken by falling through a `default` branch nobody listed.
    const days: [Operator, unknown][] = [
      ["eq", "2026-01-17"],
      ["neq", "2026-01-17"],
      ["lte", "2026-01-17"],
      ["gt", "2026-01-17"],
      ["gte", "2026-01-17"],
      ["lt", "2026-01-17"],
      ["between", ["2026-01-01", "2026-06-30"]],
    ];

    for (const [operator, value] of days) {
      const { sql } = buildQuery(
        base({ filters: { op: "and", conditions: [{ path: "date", operator, value }] } }),
        ADMIN,
      );
      expect(sql, operator).toContain("AT TIME ZONE 'America/La_Paz'");
      expect(sql, operator).not.toMatch(/\$\d+::date AT TIME ZONE/);
    }
  });

  it("treats gte and lt on a bare date as whole days", () => {
    // Both fell through to a default that ignored the field's kind, so the
    // date was compared as an instant in the session's zone: "desde el 17"
    // started at 20:00 of the 16th and returned 225 events where 195 occurred.
    // They were also inconsistent with their own partners — `lte` covered the
    // whole day and `lt` did not, `gt` covered it and `gte` did not.
    const gte = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "gte", value: "2026-06-30" }] } }),
      ADMIN,
    ).sql;
    expect(gte).toMatch(/>= \(\(\$\d+::date\)::timestamp AT TIME ZONE 'America\/La_Paz'\)/);

    const lt = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "lt", value: "2026-06-30" }] } }),
      ADMIN,
    ).sql;
    expect(lt).toMatch(/< \(\(\$\d+::date\)::timestamp AT TIME ZONE 'America\/La_Paz'\)/);

    // The pair partitions the set: what `lt` excludes is exactly what `gte`
    // keeps, so the same instant appears in both.
    expect(gte.replace(">=", "<")).toContain(lt.slice(lt.indexOf("<")));
  });

  it("only refuses the summaries that a foreign grain actually corrupts", () => {
    // The first version of this guard refused every summary over anything
    // reached through a relation, which deleted reports that were answering
    // correctly. What multiplies is adding a parent's value up once per child
    // row -- and counting, when the expression is already a counting subquery,
    // because that pair becomes a SUM. The rest do not care how often a value
    // repeats.
    const grouped = (path: string, agg: AggFn) => () =>
      buildQuery(
        {
          root: "revision",
          columns: [{ path: "evento.state" }, { path, agg }],
          groupBy: ["evento.state"],
        },
        ADMIN,
      );

    // `SUM(evento.diasAbierto)` over revisions returned 1.026.699 where each
    // event counted once gives 103.323.
    expect(grouped("evento.diasAbierto", "sum")).toThrow(/total de otra entidad/);
    // The maximum of a value repeated ten times is that value.
    expect(grouped("evento.diasAbierto", "max")).not.toThrow();
    expect(grouped("evento.diasAbierto", "min")).not.toThrow();
    // And counting a parent's plain column counts this report's own rows.
    expect(grouped("evento.description", "count")).not.toThrow();
  });

  it("does not offer a summary it is going to refuse", () => {
    // The picker and the builder have to agree, or a click in the interface can
    // only ever end in a 400. `sqlExecution.test.ts` sweeps this across the
    // whole catalog; this pins the specific rule.
    const view = buildCatalogView(ADMIN);
    const revision = view.roots.find((r) => r.key === "revision");
    const throughRelation = revision?.fields.find((f) => f.path === "evento.diasAbierto");

    expect(throughRelation?.aggregates).not.toContain("sum");
    expect(throughRelation?.aggregates).toContain("max");
  });

  it("refuses to re-total a relation's count reached through another relation", () => {
    // The same defect as the calculated-field spelling below, by the other
    // road: `poste.eventos` counted with a report of events asks each poste for
    // its own total and reads it once per event of that poste. Summed, a poste
    // with n events contributes n². Measured on real data: 1.390 reported where
    // 1.376 exist, and — grouping revisions by state — 91.195 where 7.337 exist.
    expect(() =>
      buildQuery(
        {
          root: "evento",
          columns: [{ path: "poste.tramo" }, { path: "poste.eventos", agg: "count" }],
          groupBy: ["poste.tramo"],
        },
        ADMIN,
      ),
    ).toThrow(/ya es un total de otra entidad/);
  });

  it("still shows a parent's total once per row when the report is not grouped", () => {
    // The other half of the rule, and the reason the guard cannot live where
    // the path is resolved: read once per row the number is simply true —
    // "el poste de este evento tiene 73 eventos". It is only summing it across
    // rows that squares it. Rejecting both would have deleted a legitimate
    // column to fix a different one.
    const { sql } = buildQuery(
      { root: "evento", columns: [{ path: "id" }, { path: "poste.eventos", agg: "count" }] },
      ADMIN,
    );
    expect(sql).toContain("SELECT COUNT(*)");
    expect(sql).not.toMatch(/SUM\(\(SELECT COUNT/);
  });

  it("refuses to order a summary by a total that belongs to another entity", () => {
    // The worst shape of the three, because nothing on screen contradicts it:
    // the column shows the right number and only the ranking is wrong. Ordering
    // tramos by the sum of a foreign total put three of the top eight in their
    // real places.
    expect(() =>
      buildQuery(
        {
          root: "revision",
          columns: [{ path: "evento.poste.tramo" }, { path: "id", agg: "count" }],
          groupBy: ["evento.poste.tramo"],
          sort: [{ path: "evento.numRevisiones", dir: "desc", agg: "sum" }],
        },
        ADMIN,
      ),
    ).toThrow(/ya es un total de otra entidad/);
  });

  it("refuses to re-total a count that belongs to another entity", () => {
    // `poste.numEventos` counts a poste's events. Read once per event row and
    // summed, a poste with n events contributed n²: "Total de eventos" showed
    // 75 beside a COUNT of 73 on the same line. Refused rather than computed —
    // the honest number needs a grain the configuration cannot express, and a
    // plausible-looking squared count is the worse of the two failures.
    expect(() =>
      buildQuery(
        {
          root: "evento",
          columns: [{ path: "poste.name" }, { path: "poste.numEventos", agg: "count" }],
          groupBy: ["poste.name"],
        },
        ADMIN,
      ),
    ).toThrow(/ya es un total de otra entidad/);
  });

  it("still totals a count that belongs to the root itself", () => {
    // Rooted at poste there is one row per poste, so summing is exactly right.
    expect(() =>
      buildQuery(
        {
          root: "poste",
          columns: [{ path: "material.name" }, { path: "numEventos", agg: "sum" }],
          groupBy: ["material.name"],
        },
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("excludes rows whose required parent was archived", () => {
    // A revision belongs to an event, so archiving the event archives it. The
    // paranoid LEFT JOIN could not say that — it blanked the event's columns
    // and kept the row — and it only existed when the report mentioned the
    // event at all, so the guard has to stand on its own.
    const { sql } = buildQuery({ root: "revision", columns: [{ path: "id" }] }, ADMIN);

    expect(sql).toContain('EXISTS (SELECT 1 FROM "eventos" p');
    expect(sql).toContain('p."deletedAt" IS NULL');
  });

  it("counts and lists under the same guard", () => {
    // The total sits above the rows it describes; if only one of the two
    // builders carried the guard they would stop agreeing.
    const config = { root: "revision", columns: [{ path: "id" }] };

    expect(buildCountQuery(config, ADMIN).sql).toContain('EXISTS (SELECT 1 FROM "eventos" p');
  });

  it("leaves an optional parent alone", () => {
    // An event has no required parent: a poste is optional, and losing one must
    // not remove the event from its own report.
    const { sql } = buildQuery({ root: "evento", columns: [{ path: "id" }] }, ADMIN);

    expect(sql).not.toContain("EXISTS (SELECT 1 FROM");
  });

  it("escapes the wildcards a person types into a contains filter", () => {
    // Unescaped, "contiene %" matched every row in the table and "contiene a_e"
    // matched "abe". The wildcards belong to the operator, not to the text.
    const { sql, binds } = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "description", operator: "like", value: "100%_x" }] } }),
      ADMIN,
    );

    expect(binds).toContain("%100\\%\\_x%");
    expect(sql).toContain("ESCAPE '\\'");
  });

  it("uses IS DISTINCT FROM for neq so nulls are not silently dropped", () => {
    // NULL <> 'x' is NULL, which turns the LEFT JOIN into an INNER JOIN and
    // removed 281 of 1376 events without any indication.
    const { sql } = buildQuery(
      base({
        filters: {
          op: "and",
          conditions: [{ path: "poste.name", operator: "neq", value: "P-1" }],
        },
      }),
      ADMIN,
    );
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).not.toMatch(/<>/);
  });

  it("nests and/or groups", () => {
    const { sql } = buildQuery(
      base({
        filters: {
          op: "or",
          conditions: [
            { path: "state", operator: "eq", value: true },
            { op: "and", conditions: [{ path: "priority", operator: "eq", value: true }] },
          ],
        },
      }),
      ADMIN,
    );
    expect(sql).toContain(" OR ");
  });

  it("rejects an unknown operator", () => {
    expect(() =>
      buildQuery(
        base({
          filters: {
            op: "and",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            conditions: [{ path: "description", operator: "; DROP TABLE" as any, value: 1 }],
          },
        }),
        ADMIN,
      ),
    ).toThrow(ReportConfigError);
  });

  it("rejects a filter with no value when the operator needs one", () => {
    expect(() =>
      buildQuery(
        base({ filters: { op: "and", conditions: [{ path: "date", operator: "gt" }] } }),
        ADMIN,
      ),
    ).toThrow(ReportConfigError);
  });

  it("handles isnull without a value", () => {
    const { sql } = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "image", operator: "isnull" }] } }),
      ADMIN,
    );
    expect(sql).toContain("IS NULL");
  });
});

describe("buildQuery — existence filters", () => {
  it("reproduces 'events with a revision inside the range'", () => {
    const { sql, binds } = buildQuery(
      base({
        filters: {
          op: "and",
          conditions: [
            {
              exists: "revisiones",
              where: {
                op: "and",
                conditions: [
                  { path: "date", operator: "between", value: ["2026-01-01", "2026-06-30"] },
                ],
              },
            },
          ],
        },
      }),
      ADMIN,
    );
    expect(sql).toContain("EXISTS (");
    expect(sql).toContain('FROM "revicions" e0');
    expect(sql).toContain('e0."id_evento" = t0."id"');
    expect(sql).toContain('e0."deletedAt" IS NULL');
    expect(binds).toContain("2026-01-01");
  });

  it("supports negation", () => {
    const { sql } = buildQuery(
      base({ filters: { op: "and", conditions: [{ exists: "revisiones", negate: true }] } }),
      ADMIN,
    );
    expect(sql).toContain("NOT EXISTS (");
  });

  it("works from other roots", () => {
    const { sql } = buildQuery(
      {
        root: "poste",
        columns: [{ path: "name" }],
        filters: {
          op: "and",
          conditions: [
            {
              exists: "eventos",
              where: { op: "and", conditions: [{ path: "state", operator: "eq", value: false }] },
            },
          ],
        },
      },
      ADMIN,
    );
    expect(sql).toContain('FROM "eventos" e0');
    expect(sql).toContain('e0."id_poste" = t0."id"');
  });

  it("rejects an existence filter over a to-one relation", () => {
    expect(() =>
      buildQuery(base({ filters: { op: "and", conditions: [{ exists: "poste" }] } }), ADMIN),
    ).toThrow(ReportConfigError);
  });

  it("keeps inner join aliases from colliding with outer ones", () => {
    const { sql } = buildQuery(
      base({
        columns: [{ path: "poste.name" }],
        filters: {
          op: "and",
          conditions: [
            {
              exists: "observaciones",
              where: {
                op: "and",
                conditions: [{ path: "ob.criticality", operator: "lte", value: 3 }],
              },
            },
          ],
        },
      }),
      ADMIN,
    );
    // Outer join is t1; the inner one must not reuse that alias.
    expect(sql).toContain('LEFT JOIN "postes" t1');
    expect(sql).toContain("e0_j1");
  });

  it("rejects an unknown relation in the existence filter", () => {
    expect(() =>
      buildQuery(base({ filters: { op: "and", conditions: [{ exists: "inventado" }] } }), ADMIN),
    ).toThrow(ReportConfigError);
  });
});

describe("buildQuery — injection attempts", () => {
  const attempts = [
    'description"; DROP TABLE eventos; --',
    "description' OR '1'='1",
    "../../etc/passwd",
    "poste.name); DELETE FROM postes WHERE (1=1",
    "pass",
    "usuario.pass",
  ];

  for (const path of attempts) {
    it(`rejects the path ${JSON.stringify(path)}`, () => {
      expect(() => buildQuery(base({ columns: [{ path }] }), ADMIN)).toThrow(ReportConfigError);
    });
  }

  it("rejects an unknown root", () => {
    expect(() => buildQuery(base({ root: "usuarios" }), ADMIN)).toThrow(ReportConfigError);
  });

  it("rejects an unknown aggregate", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildQuery(base({ columns: [{ path: "description", agg: "exec" as any }] }), ADMIN),
    ).toThrow(ReportConfigError);
  });

  it("rejects an empty path", () => {
    expect(() => buildQuery(base({ columns: [{ path: "" }] }), ADMIN)).toThrow(ReportConfigError);
  });

  it("rejects a malformed path", () => {
    expect(() => buildQuery(base({ columns: [{ path: "poste..name" }] }), ADMIN))
      .toThrow(ReportConfigError);
  });

  it("rejects a path deeper than the maximum", () => {
    expect(() =>
      buildQuery(
        { root: "revision", columns: [{ path: "evento.poste.ciudadA.name.extra" }] },
        ADMIN,
      ),
    ).toThrow(ReportConfigError);
  });
});

describe("buildQuery — role isolation", () => {
  it("decides by the capability and never by the role number", () => {
    // The defect in one assertion. Visibility was a list of role numbers in the
    // catalog — `roles: [1, 2]` — while the permission matrix grants role 2 no
    // `seguridad.ver` at all: `GET /usuario` answered a coordinator 403 and the
    // generator handed them the login username of every user in the system.
    //
    // So the number must not decide anything. A role 1 without the capability
    // is refused, and a role 3 with it is allowed — which is impossible to get
    // right by reading the number, whichever numbers are in the list.
    const adminSinPermiso: Viewer = { role: 1, staff: false };
    const tecnicoConPermiso: Viewer = { role: 3, staff: true };

    expect(() => buildQuery(base({ columns: [{ path: "usuario.user" }] }), adminSinPermiso))
      .toThrow(/permiso/);
    expect(() => buildQuery(base({ columns: [{ path: "usuario.user" }] }), tecnicoConPermiso))
      .not.toThrow();
  });

  it("lets an administrator read user fields", () => {
    expect(() => buildQuery(base({ columns: [{ path: "usuario.name" }] }), ADMIN)).not.toThrow();
  });

  it("denies the operative role the same field", () => {
    expect(() => buildQuery(base({ columns: [{ path: "usuario.name" }] }), OPERATIVO))
      .toThrow(/permiso/);
  });

  it("denies the operative role a filter on a restricted field", () => {
    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "usuario.name", operator: "eq", value: "x" }] },
        }),
        OPERATIVO,
      ),
    ).toThrow(/permiso/);
  });

  it("denies sorting by a restricted field", () => {
    expect(() =>
      buildQuery(base({ sort: [{ path: "usuario.name", dir: "asc" }] }), OPERATIVO),
    ).toThrow(/permiso/);
  });

  it("hides every field of the staff directory, not the four somebody remembered", () => {
    // Written as a sweep because the leak was not one forgotten field: it was a
    // hand-written list of role numbers that disagreed with the permission
    // matrix, so *everything* it protected was handed to role 2 — names,
    // surnames, login usernames, telephones and the name of their role. Asking
    // one path would keep passing the day a fifth column is added.
    const forbidden = buildCatalogView(ADMIN).roots.flatMap((root) =>
      root.fields.map((f) => ({ root: root.key, path: f.path })),
    ).filter(({ path }) => /(^|\.)usuario(\.|$)|(^|\.)rol(\.|$)/.test(path));

    // If this is zero the sweep is testing nothing, which is how a green test
    // ends up proving the opposite of what it claims.
    expect(forbidden.length).toBeGreaterThan(4);

    for (const { root, path } of forbidden) {
      expect(
        () => buildQuery({ root, columns: [{ path }] }, OPERATIVO),
        `${root}.${path} no debe ser legible sin seguridad.ver`,
      ).toThrow(/permiso/);
    }

    // And the picker never offers what the builder would refuse: a field the
    // client cannot see is a field it cannot ask for by accident.
    const offered = buildCatalogView(OPERATIVO).roots.flatMap((root) =>
      root.fields.map((f) => f.path),
    );
    expect(offered.filter((path) => /(^|\.)usuario(\.|$)|(^|\.)rol(\.|$)/.test(path))).toEqual([]);
  });
});

describe("buildQuery — limits", () => {
  it("caps the row limit at the hard ceiling", () => {
    const { binds } = buildQuery(base({ limit: 999_999 }), ADMIN);
    expect(binds[binds.length - 2]).toBe(MAX_ROWS);
  });

  it("rejects a report with no columns", () => {
    expect(() => buildQuery(base({ columns: [] }), ADMIN)).toThrow(ReportConfigError);
  });

  it("never emits a negative offset", () => {
    const { binds } = buildQuery(base({ offset: -50 }), ADMIN);
    expect(binds[binds.length - 1]).toBe(0);
  });

  it("binds limit and offset rather than inlining them", () => {
    const { sql } = buildQuery(base({ limit: 10, offset: 20 }), ADMIN);
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
  });
});

describe("buildCountQuery", () => {
  it("counts rows in detail mode", () => {
    const { sql } = buildCountQuery(base(), ADMIN);
    expect(sql).toContain("COUNT(*)");
    expect(sql).toContain('FROM "eventos" t0');
  });

  it("counts groups, not rows, in summary mode", () => {
    const { sql } = buildCountQuery(
      { root: "poste", columns: [{ path: "tramo" }], groupBy: ["tramo"] },
      ADMIN,
    );
    expect(sql).toContain("GROUP BY");
  });

  it("refuses a configuration that is not one, rather than throwing a TypeError", () => {
    // The export path counts before it reads, so this is the first function to
    // touch the request body. A missing configuration used to arrive here as a
    // TypeError and leave the API as a 500 instead of a 400.
    for (const bad of [undefined, null, "evento", 42, []]) {
      expect(() => buildCountQuery(bad as never, ADMIN))
        .toThrow(/configuración del reporte no es válida/i);
    }
  });
});

describe("buildQuery — deterministic paging", () => {
  it("always appends the primary key as tiebreaker in detail mode", () => {
    // Without it, Postgres reorders ties between statements and paging both
    // duplicated and dropped rows: 366 of 1376 in a measured run.
    const { sql } = buildQuery(base({ sort: [{ path: "state", dir: "asc" }] }), ADMIN);
    expect(sql.trim().split("\n").find((l) => l.startsWith("ORDER BY")))
      .toMatch(/t0\."id" ASC$/);
  });

  it("appends the tiebreaker even with no sort requested", () => {
    const { sql } = buildQuery(base(), ADMIN);
    expect(sql).toContain('ORDER BY t0."id" ASC');
  });

  it("orders summary mode by the group keys", () => {
    const { sql } = buildQuery(
      { root: "poste", columns: [{ path: "tramo" }], groupBy: ["tramo"] },
      ADMIN,
    );
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("LEAST(");
  });
});

describe("buildQuery — aggregates over correlated subqueries", () => {
  it("sums a to-many count instead of counting root rows", () => {
    // COUNT() over a scalar subquery counts rows, because the subquery is never
    // NULL. It reported 19 (events) where the truth was 76 (revisions).
    const { sql } = buildQuery(
      {
        root: "evento",
        columns: [{ path: "poste.tramo" }, { path: "revisiones", agg: "count" }],
        groupBy: ["poste.tramo"],
      },
      ADMIN,
    );
    expect(sql).toContain("SUM((SELECT COUNT(*)");
    expect(sql).not.toContain("COUNT((SELECT");
  });

  it("sums a calculated subquery field too", () => {
    const { sql } = buildQuery(
      {
        root: "evento",
        columns: [{ path: "poste.tramo" }, { path: "numRevisiones", agg: "count" }],
        groupBy: ["poste.tramo"],
      },
      ADMIN,
    );
    expect(sql).toContain("SUM((SELECT COUNT(*)");
  });

  it("rejects avg over a to-many rather than averaging averages", () => {
    expect(() =>
      buildQuery(
        {
          root: "evento",
          columns: [{ path: "poste.tramo" }, { path: "observaciones.id", agg: "avg" }],
          groupBy: ["poste.tramo"],
        },
        ADMIN,
      ),
    ).toThrow(/ya es un promedio por fila/);
  });

  it("keeps min and max nesting, which are correct", () => {
    const { sql } = buildQuery(
      {
        root: "evento",
        columns: [{ path: "poste.tramo" }, { path: "revisiones.date", agg: "max" }],
        groupBy: ["poste.tramo"],
      },
      ADMIN,
    );
    expect(sql).toContain("MAX((SELECT MAX(");
  });

  it("applies the same rule to the sort expression", () => {
    const { sql } = buildQuery(
      {
        root: "evento",
        columns: [{ path: "poste.tramo" }, { path: "id", agg: "count" }],
        groupBy: ["poste.tramo"],
        sort: [{ path: "revisiones", dir: "desc", agg: "count" }],
      },
      ADMIN,
    );
    expect(sql).toContain("ORDER BY SUM((SELECT COUNT(*)");
  });

  it("rejects an aggregate on a column that is also grouped", () => {
    expect(() =>
      buildQuery(
        { root: "evento", columns: [{ path: "state" }, { path: "state", agg: "count" }], groupBy: ["state"] },
        ADMIN,
      ),
    ).toThrow(/no puede llevar además un resumen/);
  });
});

describe("buildQuery — type compatibility", () => {
  it("rejects a text operator on a date field", () => {
    expect(() =>
      buildQuery(
        base({ filters: { op: "and", conditions: [{ path: "date", operator: "like", value: "x" }] } }),
        ADMIN,
      ),
    ).toThrow(/tipo fecha/);
  });

  it("rejects a numeric comparison on a boolean field", () => {
    expect(() =>
      buildQuery(
        base({ filters: { op: "and", conditions: [{ path: "state", operator: "gt", value: 5 }] } }),
        ADMIN,
      ),
    ).toThrow(/tipo sí\/no/);
  });

  it("rejects summing a text column", () => {
    expect(() =>
      buildQuery(
        { root: "evento", columns: [{ path: "state" }, { path: "description", agg: "sum" }], groupBy: ["state"] },
        ADMIN,
      ),
    ).toThrow(/tipo texto/);
  });

  it("rejects objects inside an in-list", () => {
    expect(() =>
      buildQuery(
        base({
          filters: { op: "and", conditions: [{ path: "id", operator: "in", value: [{ a: 1 }] }] },
        }),
        ADMIN,
      ),
    ).toThrow(ReportConfigError);
  });
});

describe("buildQuery — resource limits", () => {
  it("rejects a report with too many columns", () => {
    const columns = Array.from({ length: 200 }, () => ({ path: "description" }));
    expect(() => buildQuery(base({ columns }), ADMIN)).toThrow(/demasiadas columnas/);
  });

  it("rejects too many filter conditions", () => {
    const conditions = Array.from({ length: 200 }, () => ({
      path: "state", operator: "eq" as const, value: true,
    }));
    expect(() => buildQuery(base({ filters: { op: "and", conditions } }), ADMIN))
      .toThrow(/demasiados filtros/);
  });

  it("rejects too many sort criteria", () => {
    const sort = Array.from({ length: 40 }, () => ({ path: "date", dir: "asc" as const }));
    expect(() => buildQuery(base({ sort }), ADMIN)).toThrow(/demasiados criterios/);
  });

  it("rejects deeply nested filter groups instead of blowing the stack", () => {
    let nested: Record<string, unknown> = { op: "and", conditions: [] };
    for (let i = 0; i < 200; i++) nested = { op: "and", conditions: [nested] };
    expect(() => buildQuery(base({ filters: nested as never }), ADMIN)).toThrow(ReportConfigError);
  });
});

describe("buildQuery — malformed input", () => {
  it("rejects a null column with a readable message", () => {
    expect(() => buildQuery(base({ columns: [null as never] }), ADMIN))
      .toThrow(ReportConfigError);
  });

  it("rejects a null filter condition", () => {
    expect(() =>
      buildQuery(base({ filters: { op: "and", conditions: [null as never] } }), ADMIN),
    ).toThrow(ReportConfigError);
  });

  it("rejects a non-array groupBy", () => {
    expect(() => buildQuery(base({ groupBy: 5 as never }), ADMIN)).toThrow(ReportConfigError);
  });

  it("rejects a non-array sort", () => {
    expect(() => buildQuery(base({ sort: 5 as never }), ADMIN)).toThrow(ReportConfigError);
  });

  it("rejects a non-string column label", () => {
    expect(() => buildQuery(base({ columns: [{ path: "id", label: 5 as never }] }), ADMIN))
      .toThrow(ReportConfigError);
  });

  it("rejects prototype properties as field names", () => {
    // `revisiones.constructor` used to resolve to Object's constructor and emit
    // "undefined" as a column name.
    for (const path of ["revisiones.constructor", "constructor", "poste.toString"]) {
      expect(() => buildQuery(base({ columns: [{ path, agg: "max" }] }), ADMIN))
        .toThrow(ReportConfigError);
    }
  });

  it("accepts stringified limit and offset", () => {
    const { binds } = buildQuery(base({ limit: "10" as never, offset: "20" as never }), ADMIN);
    expect(binds[binds.length - 2]).toBe(10);
    expect(binds[binds.length - 1]).toBe(20);
  });

  it("truncates fractional limit and offset", () => {
    const { binds } = buildQuery(base({ limit: 2.7, offset: 1.5 }), ADMIN);
    expect(binds[binds.length - 2]).toBe(2);
    expect(binds[binds.length - 1]).toBe(1);
  });
});

describe("buildCountQuery — root validation", () => {
  it("rejects a non-root entity even when called directly", () => {
    expect(() => buildCountQuery({ root: "usuario", columns: [{ path: "name" }] }, ADMIN))
      .toThrow(ReportConfigError);
  });
});

describe("catalog safety", () => {
  it("exposes no credential-like field", () => {
    const forbidden = /pass|password|token|secret|hash/i;
    for (const [entityName, entity] of Object.entries(catalog.entities)) {
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        expect(
          forbidden.test(fieldName) || forbidden.test(field.column),
          `${entityName}.${fieldName} looks like a credential field`,
        ).toBe(false);
      }
    }
  });

  it("declares every relation target", () => {
    for (const entity of Object.values(catalog.entities)) {
      for (const relation of Object.values(entity.relations)) {
        expect(catalog.entities[relation.target]).toBeDefined();
      }
    }
  });

  it("gives every to-one relation a local key and every to-many a foreign key", () => {
    for (const entity of Object.values(catalog.entities)) {
      for (const relation of Object.values(entity.relations)) {
        if (relation.kind === "toOne") expect(relation.localKey).toBeTruthy();
        else expect(relation.foreignKey).toBeTruthy();
        if (relation.kind === "toOneLatest") expect(relation.latestBy).toBeTruthy();
      }
    }
  });

  it("declares every root as a known entity", () => {
    for (const root of catalog.roots) expect(catalog.entities[root]).toBeDefined();
  });
});
