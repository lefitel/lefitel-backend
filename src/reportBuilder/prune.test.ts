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
    sort: [{ path: "numRevisiones", direction: "desc" }],
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
