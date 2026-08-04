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
    expect(sql).toContain('ORDER BY x."date" DESC NULLS LAST LIMIT 1');
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

  it("binds both ends of a between", () => {
    const { sql, binds } = buildQuery(
      base({
        filters: {
          op: "and",
          conditions: [{ path: "date", operator: "between", value: ["2026-01-01", "2026-06-30"] }],
        },
      }),
      ADMIN,
    );
    expect(sql).toMatch(/BETWEEN \$\d+ AND \$\d+/);
    expect(binds).toContain("2026-01-01");
    expect(binds).toContain("2026-06-30");
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
