// What a reader is handed, and what they are not.

import { describe, it, expect } from "vitest";
import { pruneConfig } from "./prune.js";
import type { ReportConfig } from "./types.js";
import type { Viewer } from "./viewer.js";

const STAFF: Viewer = { role: 1, staff: true };
const PLAIN: Viewer = { role: 3, staff: false };

const shared: ReportConfig = {
  root: "evento",
  columns: [{ path: "description" }, { path: "usuario.user" }],
  groupBy: ["usuario.rol.name"],
  sort: [{ path: "usuario.user", dir: "asc" }],
  filters: {
    op: "and",
    conditions: [
      { path: "description", operator: "like", value: "poste" },
      { path: "usuario.user", operator: "eq", value: "isaias" },
    ],
  },
};

describe("pruneConfig", () => {
  it("removes every mention of a field the reader may not use", () => {
    // A shared report names the fields it was built from. Handed back verbatim,
    // it told every reader that `usuario.user` exists and what somebody filtered
    // it against — the personal data the catalog refuses them, arriving as
    // metadata instead of as rows.
    const { config, omitted } = pruneConfig(shared, PLAIN);
    const asText = JSON.stringify(config);

    expect(asText).not.toContain("usuario.user");
    expect(asText).not.toContain("usuario.rol");
    expect(asText).not.toContain("isaias");
    expect(config.columns).toEqual([{ path: "description" }]);
    // Four pieces gone: a column, a grouping, a sort and a filter.
    expect(omitted).toBe(4);
  });

  it("leaves the report untouched for a reader who may see it all", () => {
    const { config, omitted } = pruneConfig(shared, STAFF);

    expect(omitted).toBe(0);
    expect(config.columns).toHaveLength(2);
    expect(JSON.stringify(config)).toContain("usuario.user");
  });

  it("drops an advanced filter whole rather than widening it", () => {
    // Removing one clause of a sentence does not narrow it, it changes what it
    // says: "eventos con alguna revisión en mayo" stripped of its date range
    // becomes "eventos con alguna revisión", which returns rows the author
    // filtered out on purpose.
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "description" }],
      filters: {
        op: "and",
        conditions: [
          {
            exists: "revisiones",
            where: {
              op: "and",
              conditions: [{ path: "usuario.user", operator: "eq", value: "isaias" }],
            },
          },
        ],
      },
    };

    const pruned = pruneConfig(config, PLAIN);
    expect(pruned.config.filters?.conditions).toEqual([]);
    expect(pruned.omitted).toBe(1);
  });

  it("survives a stored configuration that is not one", () => {
    // These come out of a jsonb column and can be any shape at all. Reading
    // `.path` off a null is how the click handler threw and the report neither
    // opened nor said why.
    const broken = {
      root: "evento",
      columns: [null, { path: "description" }, {}],
      filters: { op: "and", conditions: [null, "texto", { path: "description", operator: "eq", value: "x" }] },
    } as unknown as ReportConfig;

    expect(() => pruneConfig(broken, PLAIN)).not.toThrow();
    const pruned = pruneConfig(broken, PLAIN);
    expect(pruned.config.columns).toEqual([{ path: "description" }]);
    expect(pruned.config.filters?.conditions).toHaveLength(1);
  });

  it("leaves an unknown level of detail alone", () => {
    // The builder refuses it with a sentence naming the level, which is more
    // use to the reader than an empty configuration.
    const config = { root: "no_existe", columns: [{ path: "id" }] } as ReportConfig;
    const pruned = pruneConfig(config, PLAIN);

    expect(pruned.config).toBe(config);
    expect(pruned.omitted).toBe(0);
  });
});

describe("what the builder accepts and the menu does not list", () => {
  // Pruning used to ask the catalog's *menu*, which is narrower than the
  // language on purpose. Every report below builds and runs; each one opened
  // with a piece missing, for its own author, under a warning that blamed
  // fields "ya no disponibles".

  it("keeps an «existe» filter whose conditions belong to the related entity", () => {
    // «Postes con algún evento pendiente». `state` is a field of an event, and
    // it was looked up among the fields of a poste.
    const config: ReportConfig = {
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
    };

    for (const viewer of [STAFF, PLAIN]) {
      const pruned = pruneConfig(config, viewer);
      expect(pruned.omitted).toBe(0);
      expect(pruned.config.filters?.conditions).toEqual(config.filters?.conditions);
    }
  });

  it("still drops an «existe» filter that names something the related entity lacks", () => {
    // The control for the test above: `lng` is a field of a poste and not of
    // an event, so judged against the right entity this one goes.
    const config: ReportConfig = {
      root: "poste",
      columns: [{ path: "name" }],
      filters: {
        op: "and",
        conditions: [
          {
            exists: "eventos",
            where: { op: "and", conditions: [{ path: "lng", operator: "notnull" }] },
          },
        ],
      },
    };

    expect(pruneConfig(config, STAFF).config.filters?.conditions).toEqual([]);
  });

  it("keeps a path that reaches an entity the long way round, and says what it is", () => {
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "description" }, { path: "ultimaRevision.evento.description" }],
      groupBy: [],
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.omitted).toBe(0);
    expect(pruned.config.columns).toHaveLength(2);
    // The client has no entry for it in the catalog it downloaded, so the
    // description travels with the report — and only for the hidden path.
    expect(pruned.extraFields.map((f) => f.path)).toEqual(["ultimaRevision.evento.description"]);
    expect(pruned.extraFields[0]).toMatchObject({
      kind: "string",
      group: "Evento › Última revisión › Evento",
    });
  });

  it("keeps a parent's root-only total", () => {
    const config: ReportConfig = {
      root: "poste",
      columns: [{ path: "name" }, { path: "ciudadA.numPostes" }],
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.omitted).toBe(0);
    expect(pruned.extraFields.map((f) => f.path)).toEqual(["ciudadA.numPostes"]);
  });

  it("keeps an order by a field the report does not show", () => {
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "description" }],
      sort: [{ path: "date", dir: "desc" }],
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.omitted).toBe(0);
    expect(pruned.config.sort).toEqual(config.sort);
    // `date` is on the menu, so there is nothing to describe.
    expect(pruned.extraFields).toEqual([]);
  });

  it("drops an order with no column when the builder would refuse it", () => {
    // The control: nothing in a plain listing applies a sum, so the builder
    // answers 400 to this one and keeping it would save a report that cannot run.
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "description" }],
      sort: [{ path: "criticidad", dir: "desc", agg: "sum" }],
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.config.sort).toEqual([]);
    expect(pruned.omitted).toBe(1);
  });

  it("reads a stored `agg: null` as no summary at all", () => {
    const config = {
      root: "evento",
      columns: [{ path: "description", agg: null }],
      sort: [{ path: "description", dir: "asc" }],
    } as unknown as ReportConfig;

    expect(pruneConfig(config, STAFF).config.sort).toHaveLength(1);
  });

  it("goes on hiding personal data reached the long way round", () => {
    // What must not have moved: asking the builder instead of the menu widens
    // what a reader keeps, and the builder refuses these exactly as it did.
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "description" }, { path: "ultimaRevision.evento.usuario.user" }],
      filters: {
        op: "and",
        conditions: [{ path: "ultimaRevision.evento.usuario.user", operator: "eq", value: "isaias" }],
      },
    };

    const plain = pruneConfig(config, PLAIN);
    expect(JSON.stringify(plain)).not.toContain("usuario");
    expect(JSON.stringify(plain)).not.toContain("isaias");
    expect(plain.omitted).toBe(2);
    expect(plain.extraFields).toEqual([]);

    // And the same report is whole for somebody who may see it.
    expect(pruneConfig(config, STAFF).omitted).toBe(0);
  });
});

describe("a to-many relation the menu does not list", () => {
  // The same narrowing as the fields: the menu does not walk back into an
  // entity it is standing in, so it never mentions «las revisiones del evento
  // de la última revisión». The builder counts them.
  const hidden = "ultimaRevision.evento.revisiones";

  it("keeps a count of one, as a column and as an order, and names the relation", () => {
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "id" }, { path: hidden, agg: "count" }],
      sort: [{ path: hidden, agg: "count", dir: "desc" }],
    };

    for (const viewer of [STAFF, PLAIN]) {
      const pruned = pruneConfig(config, viewer);
      expect(pruned.omitted).toBe(0);
      expect(pruned.extraRelations).toEqual([
        { path: hidden, label: "Revisiones", group: "Evento › Última revisión › Evento" },
      ]);
    }
  });

  it("names the relation of an «existe» filter too", () => {
    // Kept by the server and deleted by the client, which only knew the menu's
    // relations: the report opened wider than saved, with the loss announced
    // as permanent on the next save.
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "id" }],
      filters: { op: "and", conditions: [{ exists: hidden }] },
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.omitted).toBe(0);
    expect(pruned.extraRelations.map((r) => r.path)).toEqual([hidden]);
  });

  it("sends nothing extra for a relation the menu already has", () => {
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "id" }, { path: "revisiones", agg: "count" }, { path: "revisiones.date", agg: "max" }],
      filters: { op: "and", conditions: [{ exists: "revisiones" }] },
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.omitted).toBe(0);
    expect(pruned.extraRelations).toEqual([]);
  });

  it("does not keep whatever is written under a to-many relation", () => {
    // It did: the test was on the prefix alone, so a phone number three hops
    // past «revisiones» survived for a reader who may not see one — as a
    // column, as an order, and as a filter with its value.
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "id" }, { path: "revisiones.usuario.phone", agg: "count" }],
      sort: [{ path: "revisiones.usuario.phone", agg: "count", dir: "asc" }],
      filters: {
        op: "and",
        conditions: [{ path: "revisiones.usuario.phone", operator: "eq", value: "71234567" }],
      },
    };

    for (const viewer of [STAFF, PLAIN]) {
      const pruned = pruneConfig(config, viewer);
      expect(JSON.stringify(pruned)).not.toContain("phone");
      expect(JSON.stringify(pruned)).not.toContain("71234567");
      expect(pruned.omitted).toBe(3);
    }
  });
});

describe("what only the builder can refuse", () => {
  it("drops a hidden field whose own joins run past the depth limit", () => {
    // `describePath` finds it — three hops and a calculated leaf — and nothing
    // in that description shows that the leaf needs a fourth. Building it does.
    // Without that question this path would be kept and the report could not run.
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "id" }, { path: "solucion.evento.poste.tramo" }],
    };

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.config.columns).toEqual([{ path: "id" }]);
    expect(pruned.extraFields).toEqual([]);
  });

  it("drops a grouping by a hidden total", () => {
    const config: ReportConfig = {
      root: "evento",
      columns: [{ path: "poste.ciudadA.numPostes" }, { path: "id", agg: "count" }],
      groupBy: ["poste.ciudadA.numPostes"],
    };

    expect(pruneConfig(config, STAFF).config.groupBy).toEqual([]);
  });

  it("drops an «existe» nested deeper than the builder goes", () => {
    // Every level is a valid path — from a revision, the revisions of its
    // event — so depth is the only thing that separates the two below.
    const fromRevision = (levels: number): unknown =>
      levels === 0
        ? { exists: "evento.revisiones" }
        : { exists: "evento.revisiones", where: { op: "and", conditions: [fromRevision(levels - 1)] } };
    const nested = (levels: number) => ({
      root: "evento",
      columns: [{ path: "id" }],
      filters: {
        op: "and",
        conditions: [{ exists: "revisiones", where: { op: "and", conditions: [fromRevision(levels)] } }],
      },
    }) as unknown as ReportConfig;

    expect(pruneConfig(nested(1), STAFF).config.filters?.conditions).toHaveLength(1);
    expect(pruneConfig(nested(6), STAFF).config.filters?.conditions).toEqual([]);
  });
});

describe("a stored configuration it cannot read", () => {
  // The listing prunes a page of reports in one answer. One of these threw,
  // and every reader's list of saved reports became a 500.

  it("reads `where: null` as no condition at all, which is how it saved", () => {
    // The builder tests `if (node.where)`, so this is a report anybody with
    // permission to create one can store.
    const top = {
      root: "evento",
      columns: [{ path: "id" }],
      filters: { op: "and", conditions: [{ exists: "revisiones", where: null }] },
    } as unknown as ReportConfig;
    const nested = {
      root: "poste",
      columns: [{ path: "name" }],
      filters: {
        op: "and",
        conditions: [{
          exists: "eventos",
          where: { op: "and", conditions: [{ exists: "revisiones", where: null }] },
        }],
      },
    } as unknown as ReportConfig;

    for (const config of [top, nested]) {
      const pruned = pruneConfig(config, PLAIN);
      expect(pruned.omitted).toBe(0);
      expect(pruned.config.filters?.conditions).toHaveLength(1);
    }
  });

  it("never throws, whatever is in the column", () => {
    let deep: unknown = { path: "description", operator: "eq", value: "x" };
    for (let i = 0; i < 20_000; i++) deep = { op: "and", conditions: [deep] };

    const shapes: unknown[] = [
      { root: "evento", columns: [{ path: "id" }], groupBy: 0 },
      { root: "evento", columns: [{ path: "id" }], sort: 0 },
      { root: "evento", columns: 7 },
      { root: "evento", columns: [{ path: "id" }], filters: { op: "and", conditions: 0 } },
      { root: "evento", columns: [{ path: "id" }], filters: { op: "and", conditions: "abc" } },
      { root: "evento", columns: [{ path: "id" }], filters: "nada" },
      { root: "evento", columns: [{ path: "id" }], filters: { op: "and", conditions: [deep] } },
    ];

    for (const shape of shapes) {
      expect(() => pruneConfig(shape as ReportConfig, PLAIN)).not.toThrow();
    }
  });

  it("hands over nothing of a configuration that defeats it, and says so", () => {
    let deep: unknown = { path: "description", operator: "eq", value: "secreto" };
    for (let i = 0; i < 20_000; i++) deep = { op: "and", conditions: [deep] };
    const config = {
      root: "evento",
      columns: [{ path: "id" }],
      filters: { op: "and", conditions: [deep] },
    } as unknown as ReportConfig;

    const pruned = pruneConfig(config, PLAIN);
    expect(pruned.config.columns).toEqual([]);
    expect(pruned.config.filters?.conditions).toEqual([]);
    expect(pruned.omitted).toBeGreaterThan(0);
  });

  it("strips a stored `agg: null`, which the client reads as a different column", () => {
    const config = {
      root: "evento",
      columns: [{ path: "description", agg: null }],
      sort: [{ path: "description", dir: "asc", agg: null }],
    } as unknown as ReportConfig;

    const pruned = pruneConfig(config, STAFF);
    expect(pruned.config.columns).toEqual([{ path: "description" }]);
    expect(pruned.config.sort).toEqual([{ path: "description", dir: "asc" }]);
    expect(pruned.omitted).toBe(0);
  });
});

describe("a root this viewer may not use", () => {
  // The gap that made this whole module skippable. `viewFor` returns the
  // *filtered* view, so "root does not exist" and "root is hidden from you"
  // both came back undefined and both got the free pass — which meant a saved
  // report rooted at `usuario` was handed to a non-staff reader intact, filter
  // values and all. Running it was refused; the values had already arrived.
  const CLIENTE: Viewer = { role: 3, staff: false };
  const ADMIN: Viewer = { role: 1, staff: true };

  /** The report this feature exists to enable, narrowed by personal data. */
  const perPerson: ReportConfig = {
    root: "usuario",
    columns: [{ path: "name" }, { path: "phone" }, { path: "numRevisiones" }],
    filters: {
      op: "and",
      conditions: [
        { path: "phone", operator: "like", value: "71234567" },
        { path: "user", operator: "eq", value: "jperez" },
      ],
    },
    sort: [{ path: "numRevisiones", dir: "desc" }],
    groupBy: [],
  } as unknown as ReportConfig;

  it("hands a non-staff reader nothing at all, and says how much", () => {
    const { config, omitted } = pruneConfig(perPerson, CLIENTE);

    expect(config.columns).toEqual([]);
    expect(config.filters?.conditions).toEqual([]);
    expect(config.sort).toEqual([]);
    // The root itself is the thing being withheld, so it cannot survive.
    expect(config.root).toBe("");
    // 3 columns + 2 filters + 1 sort.
    expect(omitted).toBe(6);
  });

  it("does not leak the filter value, which is the personal data", () => {
    const { config } = pruneConfig(perPerson, CLIENTE);
    expect(JSON.stringify(config)).not.toContain("71234567");
    expect(JSON.stringify(config)).not.toContain("jperez");
  });

  it("leaves it untouched for somebody who may use it", () => {
    const { config, omitted } = pruneConfig(perPerson, ADMIN);
    expect(omitted).toBe(0);
    expect(config.columns).toHaveLength(3);
    expect(config.root).toBe("usuario");
  });

  it("still leaves a genuinely unknown root alone, for the builder to name", () => {
    // Unchanged behaviour, and the reason the two cases had to be told apart
    // rather than both closed: an empty configuration says nothing, while the
    // builder's refusal names the level of detail that does not exist.
    const bogus = { root: "no_existe", columns: [{ path: "x" }] } as unknown as ReportConfig;
    const { config, omitted } = pruneConfig(bogus, ADMIN);
    expect(omitted).toBe(0);
    expect(config).toBe(bogus);
  });
});
