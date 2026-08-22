// Flattens the catalog graph into the field list the UI consumes.
//
// Filtering happens here, on the server: a caller never receives the fields they
// are not allowed to use, so there is nothing for the client to hide.

import { catalog, MAX_DEPTH, MAX_ROWS } from "./catalog.js";
import { AGGS_BY_KIND, OPERATORS_BY_KIND } from "./constraints.js";
import { MAX_COLUMNS, MAX_CONDITIONS, MAX_SORTS } from "./sqlBuilder.js";
import type { AggFn, EntityDef, FieldKind, FieldSemantic, Operator } from "./types.js";
import { isVisible, type Viewer } from "./viewer.js";

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
  solucion: "Una fila por solución aplicada",
  ciudad: "Una fila por ciudad",
  usuario: "Una fila por usuario",
};

/**
 * Plural noun for a row of each root, for sentences like "1.376 eventos".
 *
 * Separate from ROW_MEANING because that one is a full sentence and cutting a
 * noun out of it would be guesswork. A grouped report changes what a row is, and
 * an indicator strip that says "eventos" over a list of tramos is a lie.
 */
const ROW_NOUN: Record<string, string> = {
  evento: "eventos",
  poste: "postes",
  revision: "revisiones",
  eventoObs: "observaciones",
  solucion: "soluciones",
  ciudad: "ciudades",
  usuario: "usuarios",
};

/** Falls back to the entity label so a new root is never left unnamed. */
export function rowNoun(root: string): string {
  return ROW_NOUN[root] ?? (catalog.entities[root]?.label ?? root).toLowerCase();
}

function collect(
  entity: EntityDef,
  viewer: Viewer,
  prefix: string,
  group: string,
  depth: number,
  out: CatalogRootView,
  seen: Set<string>,
  /**
   * The entity keys already walked through, root first.
   *
   * Used to refuse a relation that leads back into an entity the path is
   * already standing in. Without it the menu offered its way home the long way
   * round: an event report listed a whole group called "Evento › Última
   * revisión › Evento" — the description of the very event being reported —
   * and under it "Evento › Última revisión › Evento › Poste", the same pole
   * reached by a detour. Thirty-three of the seventy-eight fields an event
   * report offered were that, and adding one relation to Solución silently
   * doubled it to sixty-six of a hundred and eighteen.
   *
   * Siblings are not cycles: `ciudadA` and `ciudadB` both point at Ciudad from
   * the same pole and neither is an ancestor of the other, so both survive.
   * That is why this is the ancestor chain and not everything seen so far.
   *
   * This prunes the menu, not the language: a stored configuration naming one
   * of those paths still builds, because the SQL was always valid.
   */
  chain: readonly string[],
): void {
  const withPrefix = (name: string) => (prefix ? `${prefix}.${name}` : name);

  for (const [name, field] of Object.entries(entity.fields)) {
    if (!isVisible(field.staffOnly, viewer)) continue;
    const path = withPrefix(name);
    if (seen.has(path)) continue;
    seen.add(path);
    out.fields.push({
      path,
      label: field.label,
      kind: field.kind,
      group,
      operators: OPERATORS_BY_KIND[field.kind],
      // `sum` is dropped for anything reached through a relation: the value
      // belongs to the parent and is read once per row of this report, so
      // adding those readings up multiplies. `count` counts the report's own
      // rows and `min`/`max` do not care how often a value repeats, so both
      // stay. The builder refuses the same combination — a picker that offers
      // it is offering an error.
      aggregates: prefix
        ? AGGS_BY_KIND[field.kind].filter((agg) => agg !== "sum")
        : AGGS_BY_KIND[field.kind],
      semantic: field.semantic,
    });
  }

  for (const [name, calc] of Object.entries(entity.calculated ?? {})) {
    if (!isVisible(calc.staffOnly, viewer)) continue;
    // Offered only at the root it belongs to. See `rootOnly` in types.ts.
    if (calc.rootOnly === true && prefix !== "") continue;
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
      // A total reached through a relation belongs to that entity's grain, not
      // to the report's, so summarising it counts the same subquery once per
      // row — a poste with n events contributed n². The builder refuses it, and
      // by the rule just above, a picker that offers it is offering an error.
      aggregates: prefix
        ? calc.innerAgg !== undefined
          ? []
          : AGGS_BY_KIND[calc.kind].filter((agg) => agg !== "sum")
        : AGGS_BY_KIND[calc.kind],
      calculated: true,
      semantic: calc.semantic,
      aggregate: calc.innerAgg !== undefined,
    });
  }

  for (const [name, relation] of Object.entries(entity.relations)) {
    if (!isVisible(relation.staffOnly, viewer)) continue;
    const path = withPrefix(name);

    if (relation.kind === "toMany") {
      if (out.aggregateOnly.some((a) => a.path === path)) continue;
      out.aggregateOnly.push({ path, label: relation.label, group });
      continue;
    }

    // Relation hops are bounded; a deeper path would be rejected by the builder anyway.
    if (depth >= MAX_DEPTH) continue;

    // Back into an entity we are already inside. See `chain`.
    if (chain.includes(relation.target)) continue;

    const target = catalog.entities[relation.target];
    if (!target) continue;
    collect(target, viewer, path, `${group} › ${relation.label}`, depth + 1, out, seen, [
      ...chain,
      relation.target,
    ]);
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

/** Builds the full catalog view for a viewer, one entry per allowed root. */
export function buildCatalogView(viewer: Viewer): { roots: CatalogRootView[]; limits: CatalogLimits } {
  const roots = catalog.roots
    // A root this viewer may not use is not offered: `usuario` is a level of
    // detail made entirely of other people's personal data, and offering it
    // with every field hidden is a question that answers itself with an error.
    .filter((key) => isVisible(catalog.entities[key]?.staffOnly, viewer))
    .map((key) => {
      const entity = catalog.entities[key];
      const view: CatalogRootView = {
        key,
        label: entity.label,
        rowMeaning: ROW_MEANING[key] ?? `Una fila por ${entity.label.toLowerCase()}`,
        fields: [],
        aggregateOnly: [],
      };
      collect(entity, viewer, "", entity.label, 0, view, new Set(), [key]);
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
