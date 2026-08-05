// Flattens the catalog graph into the field list the UI consumes.
//
// Filtering happens here, on the server: a role never receives the fields it is
// not allowed to use, so there is nothing for the client to hide.

import { catalog, MAX_DEPTH, MAX_ROWS } from "./catalog.js";
import { AGGS_BY_KIND, OPERATORS_BY_KIND } from "./constraints.js";
import { MAX_COLUMNS, MAX_CONDITIONS, MAX_SORTS } from "./sqlBuilder.js";
import type { AggFn, EntityDef, FieldKind, FieldSemantic, Operator } from "./types.js";

export interface CatalogFieldView {
  /** Dotted path used in the report configuration. */
  path: string;
  label: string;
  kind: FieldKind;
  /** Human-readable grouping for the UI, e.g. "Poste › Ciudad A". */
  group: string;
  operators: Operator[];
  aggregates: AggFn[];
  /** True for values derived in SQL rather than stored columns. */
  calculated?: boolean;
  /** Domain meaning, so the client can colour rows without guessing. */
  semantic?: FieldSemantic;
  /**
   * True when the value is already a summary of its own row, such as a count of
   * revisions. Grouping by one is rejected, so the client should not offer it.
   */
  aggregate?: boolean;
}

export interface CatalogRootView {
  key: string;
  label: string;
  /** What a single row represents, shown when picking the detail level. */
  rowMeaning: string;
  fields: CatalogFieldView[];
  /** To-many relations reachable from the root, usable only as aggregates. */
  aggregateOnly: { path: string; label: string; group: string }[];
}

const ROW_MEANING: Record<string, string> = {
  evento: "Una fila por evento",
  poste: "Una fila por poste",
  revision: "Una fila por revisión",
  eventoObs: "Una fila por observación registrada en un evento",
};

const isVisible = (roles: number[] | undefined, role: number): boolean =>
  roles === undefined || roles.includes(role);

function collect(
  entity: EntityDef,
  role: number,
  prefix: string,
  group: string,
  depth: number,
  out: CatalogRootView,
  seen: Set<string>,
): void {
  const withPrefix = (name: string) => (prefix ? `${prefix}.${name}` : name);

  for (const [name, field] of Object.entries(entity.fields)) {
    if (!isVisible(field.roles, role)) continue;
    const path = withPrefix(name);
    if (seen.has(path)) continue;
    seen.add(path);
    out.fields.push({
      path,
      label: field.label,
      kind: field.kind,
      group,
      operators: OPERATORS_BY_KIND[field.kind],
      aggregates: AGGS_BY_KIND[field.kind],
      semantic: field.semantic,
    });
  }

  for (const [name, calc] of Object.entries(entity.calculated ?? {})) {
    if (!isVisible(calc.roles, role)) continue;
    // A calculated field needs its own relation hops on top of the ones already
    // spent. Advertising one the builder will reject puts a field in the picker
    // that returns an error when clicked.
    if ((calc.deps?.length ?? 0) > 0 && depth + 1 > MAX_DEPTH) continue;
    const path = withPrefix(name);
    if (seen.has(path)) continue;
    seen.add(path);
    out.fields.push({
      path,
      label: calc.label,
      kind: calc.kind,
      group,
      operators: OPERATORS_BY_KIND[calc.kind],
      aggregates: AGGS_BY_KIND[calc.kind],
      calculated: true,
      semantic: calc.semantic,
      aggregate: calc.innerAgg !== undefined,
    });
  }

  for (const [name, relation] of Object.entries(entity.relations)) {
    if (!isVisible(relation.roles, role)) continue;
    const path = withPrefix(name);

    if (relation.kind === "toMany") {
      if (out.aggregateOnly.some((a) => a.path === path)) continue;
      out.aggregateOnly.push({ path, label: relation.label, group });
      continue;
    }

    // Relation hops are bounded; a deeper path would be rejected by the builder anyway.
    if (depth >= MAX_DEPTH) continue;

    const target = catalog.entities[relation.target];
    if (!target) continue;
    collect(target, role, path, `${group} › ${relation.label}`, depth + 1, out, seen);
  }
}

/** Caps the client should honour, so the two sides cannot drift apart. */
export interface CatalogLimits {
  maxColumns: number;
  maxConditions: number;
  maxSorts: number;
  maxRows: number;
  maxDepth: number;
}

/** Builds the full catalog view for a role, one entry per allowed root. */
export function buildCatalogView(role: number): { roots: CatalogRootView[]; limits: CatalogLimits } {
  const roots = catalog.roots.map((key) => {
    const entity = catalog.entities[key];
    const view: CatalogRootView = {
      key,
      label: entity.label,
      rowMeaning: ROW_MEANING[key] ?? `Una fila por ${entity.label.toLowerCase()}`,
      fields: [],
      aggregateOnly: [],
    };
    collect(entity, role, "", entity.label, 0, view, new Set());
    return view;
  });

  return {
    roots,
    // Published rather than duplicated by hand on the client, where they had
    // already started to drift.
    limits: {
      maxColumns: MAX_COLUMNS,
      maxConditions: MAX_CONDITIONS,
      maxSorts: MAX_SORTS,
      maxRows: MAX_ROWS,
      maxDepth: MAX_DEPTH,
    },
  };
}
