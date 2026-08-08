import { describe, it, expect } from "vitest";
import { buildQuery, buildCountQuery } from "./sqlBuilder.js";
import { catalog, MAX_ROWS } from "./catalog.js";
import { ReportConfigError, type ReportConfig } from "./types.js";

const ADMIN = 1;
const OPERATIVO = 3;

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
      />= \(\$\d+::date AT TIME ZONE 'America\/La_Paz'\) AND .* < \(\(\$\d+::date \+ interval '1 day'\) AT TIME ZONE 'America\/La_Paz'\)/,
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

    expect(sql).toContain("AT TIME ZONE 'America/La_Paz'");
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
    expect(lte).toMatch(/< \(\(\$\d+::date \+ interval '1 day'\) AT TIME ZONE 'America\/La_Paz'\)/);

    const gt = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "gt", value: "2026-06-30" }] } }),
      ADMIN,
    ).sql;
    expect(gt).toMatch(/>= \(\(\$\d+::date \+ interval '1 day'\) AT TIME ZONE 'America\/La_Paz'\)/);
  });

  it("makes neq on a bare date the exact complement of eq", () => {
    // `eq` covered the whole day and `neq` compared a single instant, so the
    // two did not partition the set: "distinta del 24 de mayo" returned all
    // 1.376 events, the six of that day included.
    const { sql } = buildQuery(
      base({ filters: { op: "and", conditions: [{ path: "date", operator: "neq", value: "2024-05-24" }] } }),
      ADMIN,
    );

    expect(sql).toMatch(/t0\."date" IS NULL OR .* < \(\$\d+::date AT TIME ZONE/);
    expect(sql).toMatch(/OR .* >= \(\(\$\d+::date \+ interval '1 day'\) AT TIME ZONE/);
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
