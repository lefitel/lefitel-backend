// Flattens the catalog graph into the field list the UI consumes.
//
// Filtering happens here, on the server: a caller never receives the fields they
// are not allowed to use, so there is nothing for the client to hide.

import { catalog, MAX_DEPTH, MAX_ROWS } from "./catalog.js";
import { AGGS_BY_KIND, OPERATORS_BY_KIND, PERIODS, PERIOD_LABEL } from "./constraints.js";
import { MAX_COLUMNS, MAX_CONDITIONS, MAX_FILTER_VALUE, MAX_SORTS } from "./sqlBuilder.js";
import type {
  AggFn, CalculatedDef, EntityDef, FieldDef, FieldKind, FieldSemantic, Operator, Period,
} from "./types.js";
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
  /**
   * Names the list of values this field can hold, when there is one — see
   * `optionList` in types.ts. The lists themselves travel once, beside the
   * roots, because the same list is reached by many paths: `propietario.name`
   * hangs off a pole, off an event's pole, and off a revision's event's pole.
   *
   * A key with no list in the response is not an error and the client must
   * handle it: the list may have outgrown the cap, or the read may have failed,
   * and in both cases the honest answer is the free text box the field had
   * before.
   */
  optionList?: string;
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
const ROW_NOUN: Record<string, [one: string, many: string]> = {
  evento: ["evento", "eventos"],
  poste: ["poste", "postes"],
  revision: ["revisión", "revisiones"],
  eventoObs: ["observación", "observaciones"],
  solucion: ["solución", "soluciones"],
  ciudad: ["ciudad", "ciudades"],
  usuario: ["usuario", "usuarios"],
};

/**
 * Falls back to the entity label so a new root is never left unnamed.
 *
 * Both numbers, because the indicator strip of every exported file prefixes this
 * with a count and a one-row report used to read "1 eventos". The fallback
 * cannot know a plural, so it repeats the label for both rather than guessing
 * at an "-s".
 */
export function rowNoun(root: string, count?: number): string {
  const pair = ROW_NOUN[root];
  if (!pair) return (catalog.entities[root]?.label ?? root).toLowerCase();
  return count === 1 ? pair[0] : pair[1];
}

/** A stored column, as the picker lists it. */
function fieldView(
  name: string,
  field: FieldDef,
  entityKey: string,
  path: string,
  group: string,
  throughRelation: boolean,
): CatalogFieldView {
  return {
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
    aggregates: throughRelation
      ? AGGS_BY_KIND[field.kind].filter((agg) => agg !== "sum")
      : AGGS_BY_KIND[field.kind],
    semantic: field.semantic,
    // Keyed by entity and column, not by path: one list, however many paths
    // reach it.
    optionList: field.optionList === true ? `${entityKey}.${name}` : undefined,
  };
}

/** A value derived in SQL, as the picker lists it. */
function calculatedView(
  calc: CalculatedDef,
  path: string,
  group: string,
  throughRelation: boolean,
): CatalogFieldView {
  return {
    path,
    label: calc.label,
    kind: calc.kind,
    group,
    operators: OPERATORS_BY_KIND[calc.kind],
    // A total reached through a relation belongs to that entity's grain, not
    // to the report's, so summarising it counts the same subquery once per
    // row — a poste with n events contributed n². The builder refuses it, and
    // by the rule just above, a picker that offers it is offering an error.
    aggregates: throughRelation
      ? calc.innerAgg !== undefined
        ? []
        : AGGS_BY_KIND[calc.kind].filter((agg) => agg !== "sum")
      : AGGS_BY_KIND[calc.kind],
    calculated: true,
    semantic: calc.semantic,
    aggregate: calc.innerAgg !== undefined,
  };
}

/** Own keys only: a path segment is user text, and `constructor` is a key too. */
const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * Walks a chain of to-one relations from an entity, the way the builder does.
 *
 * Returns where it landed and the group label it would be listed under, or null
 * when any hop is missing, hidden from this viewer, or a to-many relation.
 */
function walkRelations(
  entityKey: string,
  segments: string[],
  viewer: Viewer,
): { key: string; entity: EntityDef; group: string } | null {
  let key = entityKey;
  let entity = own(catalog.entities, key);
  if (!entity) return null;
  let group = entity.label;

  for (const segment of segments) {
    const relation = own(entity.relations, segment);
    if (!relation || relation.kind === "toMany") return null;
    if (!isVisible(relation.staffOnly, viewer)) return null;
    const target = own(catalog.entities, relation.target);
    if (!target) return null;
    key = relation.target;
    entity = target;
    group = `${group} › ${relation.label}`;
  }
  return { key, entity, group };
}

/**
 * Describes one path the way the picker would, whether or not the picker lists it.
 *
 * The menu is narrower than the language on purpose — see `chain` below and
 * `rootOnly` in types.ts — so a stored configuration can name a path that is
 * perfectly valid and that `buildCatalogView` never produced. Whoever opens that
 * report still has to be shown a header, a type and a list of operators for it,
 * and this is where they come from.
 *
 * Null for anything that is not a field this viewer may use. It says nothing
 * about to-many relations, which are never fields; see `toManyTarget`.
 */
export function describePath(
  entityKey: string,
  path: string,
  viewer: Viewer,
): CatalogFieldView | null {
  if (typeof path !== "string" || path === "") return null;
  const segments = path.split(".");
  if (segments.some((s) => s === "") || segments.length - 1 > MAX_DEPTH) return null;

  const landing = walkRelations(entityKey, segments.slice(0, -1), viewer);
  if (!landing) return null;
  const leaf = segments[segments.length - 1];
  const throughRelation = segments.length > 1;

  const field = own(landing.entity.fields, leaf);
  if (field) {
    if (!isVisible(field.staffOnly, viewer)) return null;
    return fieldView(leaf, field, landing.key, path, landing.group, throughRelation);
  }
  const calc = own(landing.entity.calculated, leaf);
  if (calc) {
    if (!isVisible(calc.staffOnly, viewer)) return null;
    return calculatedView(calc, path, landing.group, throughRelation);
  }
  return null;
}

/**
 * The entity a to-many path leads to, or null when it is not one this viewer
 * may use. What an `exists` filter needs: its inner conditions are written
 * relative to that entity, not to the report's root.
 */
export function toManyTarget(entityKey: string, path: string, viewer: Viewer): string | null {
  return describeToMany(entityKey, path, viewer)?.target ?? null;
}

/**
 * A to-many relation the way `aggregateOnly` lists it, plus where it leads.
 *
 * The menu's list of these is cut by the same rule that cuts its fields — it
 * does not walk back into an entity it is standing in — so «las revisiones del
 * evento de la última revisión» is a relation the builder counts and the
 * catalog never mentions. A report that counts one, or filters on one, needs
 * its name to be drawn at all.
 *
 * The hops before it are bounded as the builder bounds them (`walkToOne`): a
 * path that would be refused for its depth is not one to keep.
 */
export function describeToMany(
  entityKey: string,
  path: string,
  viewer: Viewer,
): { path: string; label: string; group: string; target: string } | null {
  if (typeof path !== "string" || path === "") return null;
  const segments = path.split(".");
  if (segments.some((s) => s === "") || segments.length - 1 > MAX_DEPTH) return null;

  const landing = walkRelations(entityKey, segments.slice(0, -1), viewer);
  if (!landing) return null;
  const relation = own(landing.entity.relations, segments[segments.length - 1]);
  if (!relation || relation.kind !== "toMany") return null;
  if (!isVisible(relation.staffOnly, viewer)) return null;
  if (!own(catalog.entities, relation.target)) return null;
  return { path, label: relation.label, group: landing.group, target: relation.target };
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
   * of those paths still builds, because the SQL was always valid — and still
   * opens whole, because `pruneConfig` judges by the language and sends the
   * description of such a path along with the report (`describePath`).
   */
  chain: readonly string[],
): void {
  const withPrefix = (name: string) => (prefix ? `${prefix}.${name}` : name);
  // The entity being walked right now. `chain` is the ancestry with the root
  // first, so its last link is always this one — see the initial call and the
  // recursion below, which both append the entity they descend into.
  const entityKey = chain[chain.length - 1];

  for (const [name, field] of Object.entries(entity.fields)) {
    if (!isVisible(field.staffOnly, viewer)) continue;
    const path = withPrefix(name);
    if (seen.has(path)) continue;
    seen.add(path);
    out.fields.push(fieldView(name, field, entityKey, path, group, prefix !== ""));
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
    out.fields.push(calculatedView(calc, path, group, prefix !== ""));
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
  /**
   * Longest a filter value may be.
   *
   * Published because the client had no cap at all: the value box took any
   * length, and the report was refused on the way out with a sentence naming a
   * number the screen had never mentioned. Every other cap here is honoured
   * before the request leaves; this one was not.
   */
  maxFilterValue: number;
}

/** One named period a date filter may take, with the words the picker shows. */
export interface CatalogPeriod {
  key: Period;
  label: string;
}

/** Builds the full catalog view for a viewer, one entry per allowed root. */
export function buildCatalogView(viewer: Viewer): {
  roots: CatalogRootView[];
  limits: CatalogLimits;
  periods: CatalogPeriod[];
} {
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
      maxFilterValue: MAX_FILTER_VALUE,
    },
    // Published for the same reason: the values the "está en el periodo"
    // operator accepts, in the order to list them.
    periods: PERIODS.map((key) => ({ key, label: PERIOD_LABEL[key] })),
  };
}
