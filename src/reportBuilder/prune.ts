// Drops from a stored configuration whatever this viewer may not ask for, on
// the way out of the server.
//
// Two defects with the same shape. `GET /reportes/:id` handed back the stored
// configuration verbatim, so a report shared by an administrator told every
// reader the paths of the fields the catalog hides from them — `usuario.user`
// among them — together with the values filtered against those fields. And
// `POST /reportes/:id/duplicate` validated that same configuration against the
// person copying it and answered 400 quoting an internal path, over a report
// the screen had just listed as theirs to copy.
//
// Pruning answers both: a reader receives a configuration made only of what
// they may ask for, and a copy is always one they can run. What was dropped is
// counted and returned, because a report that opens quietly narrower than its
// author saved it is the other way to get this wrong — the client says so out
// loud, and it can only say it if the server tells it.
//
// The web client keeps its own copy of this logic, deliberately: it must be
// able to open a report without a round trip, and a field can also disappear
// from the catalog between saving and opening.

import { catalog, MAX_DEPTH } from "./catalog.js";
import {
  buildCatalogView, describePath, describeToMany, type CatalogFieldView, type CatalogRootView,
} from "./catalogView.js";
import { buildQuery, isExists, isFilterGroup, type FilterNode } from "./sqlBuilder.js";
import type {
  AggFn, ColumnSpec, FilterCondition, FilterGroup, ReportConfig, SortSpec,
} from "./types.js";
import type { Viewer } from "./viewer.js";

/** A to-many relation as the catalog lists one. */
type RelationView = CatalogRootView["aggregateOnly"][number];

/**
 * Whether what sits inside an `exists` survives, judged against the entity the
 * `exists` leads to.
 *
 * Those paths are written relative to that entity — `buildExists` resolves them
 * with the target as its own root — and they used to be looked up in the field
 * list of the *report's* root. So «postes con algún evento pendiente», whose
 * inner condition is `state` on an event, was dropped from a report of postes
 * for having no `state` among the fields of a poste: saved whole, opened
 * without its filter, for its own author, and written back narrower on the next
 * Actualizar.
 *
 * `depth` is the builder's own bound on nesting one `exists` inside another.
 */
function whereSurvives(
  group: FilterGroup,
  entityKey: string,
  viewer: Viewer,
  depth: number,
): boolean {
  if (!Array.isArray(group.conditions)) return false;
  return group.conditions.every((raw) => {
    const node = raw as FilterNode;
    if (!node || typeof node !== "object") return false;
    if (isFilterGroup(node)) return whereSurvives(node, entityKey, viewer, depth);
    if (isExists(node)) return existsSurvives(node, entityKey, viewer, depth + 1);
    return describePath(entityKey, (node as FilterCondition).path, viewer) !== null;
  });
}

function existsSurvives(
  node: { exists: string; where?: unknown },
  entityKey: string,
  viewer: Viewer,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const relation = describeToMany(entityKey, node.exists, viewer);
  if (relation === null) return false;
  // `null` as well as absent. The builder reads `if (node.where)`, so a report
  // carrying `where: null` saves — and reading `.op` off it here threw, which
  // answered 500 for the whole listing of saved reports, to everybody.
  if (node.where === undefined || node.where === null) return true;
  if (typeof node.where !== "object") return false;
  return isFilterGroup(node.where as FilterNode) &&
    whereSurvives(node.where as FilterGroup, relation.target, viewer, depth);
}

/** Whether a whole filter node survives — all of it, or none of it. */
function nodeSurvives(
  node: FilterNode,
  keepsField: (path: unknown) => boolean,
  rootKey: string,
  viewer: Viewer,
): boolean {
  // A stored configuration is JSON out of a database and can be any shape at
  // all, so anything malformed is dropped rather than inspected.
  if (!node || typeof node !== "object") return false;
  if (isFilterGroup(node)) {
    return node.conditions.every(
      (c) => nodeSurvives(c as FilterNode, keepsField, rootKey, viewer),
    );
  }
  if (isExists(node)) return existsSurvives(node, rootKey, viewer, 0);
  return keepsField((node as FilterCondition).path);
}

/** Whether the builder accepts this, for this viewer. */
function builds(config: ReportConfig, viewer: Viewer): boolean {
  try {
    buildQuery(config, viewer);
    return true;
  } catch {
    return false;
  }
}

/**
 * A field the menu does not list and the builder accepts, or null.
 *
 * The picker is narrower than the language on purpose: it hides the way home
 * the long way round (`ultimaRevision.evento.description`) and a parent's
 * root-only totals. Pruning used to ask the menu, so a report saved while those
 * were offered — or written through the API — lost its columns on opening, under
 * a warning that blamed fields "ya no disponibles" which the server would have
 * run without complaint.
 *
 * Asked of the builder itself, not re-derived: `describePath` says what the
 * field is, and building a one-column report says whether this viewer may
 * actually have it — the second is what refuses a calculated field whose own
 * joins run past the depth limit, which nothing in the description shows.
 */
function hiddenField(rootKey: string, path: unknown, viewer: Viewer): CatalogFieldView | null {
  if (typeof path !== "string") return null;
  const field = describePath(rootKey, path, viewer);
  if (field === null) return null;
  return builds({ root: rootKey, columns: [{ path }] }, viewer) ? field : null;
}

/**
 * The to-many relation a path counts or summarises, when the builder accepts it.
 *
 * Two spellings: the relation itself (`revisiones`, counted) and one field of
 * it (`revisiones.date`, summarised). Nothing longer — the builder refuses
 * anything deeper after a to-many hop.
 *
 * This replaces a test on the prefix alone, which kept *anything* written under
 * a to-many relation: `revisiones.usuario.phone` survived for a reader who may
 * not see a phone number, as a column, a sort or a filter, value included. No
 * current save path stores one — the builder refuses it for everybody — but a
 * configuration is whatever is in the column, and this module exists so that
 * what leaves does not depend on what got in.
 */
function toManyOf(rootKey: string, path: unknown, viewer: Viewer): RelationView | null {
  if (typeof path !== "string") return null;
  const segments = path.split(".");
  for (const length of [segments.length, segments.length - 1]) {
    if (length < 1) continue;
    const relation = describeToMany(rootKey, segments.slice(0, length).join("."), viewer);
    if (relation === null) continue;
    // `count` is the one summary every field takes, so it is the one to ask with.
    if (!builds({ root: rootKey, columns: [{ path, agg: "count" }] }, viewer)) return null;
    return { path: relation.path, label: relation.label, group: relation.group };
  }
  return null;
}

/** `agg: null` and no `agg` are the same thing once stored as JSON. */
const sameAgg = (a?: AggFn | null, b?: AggFn | null): boolean =>
  (a ?? undefined) === (b ?? undefined);

/**
 * The same piece without an `agg: null`.
 *
 * Stored JSON can carry one, and the client compares summaries strictly: an
 * order arriving with `agg: null` lit the arrow of its column and then would
 * not switch off — pressing it added a second, identical criterion beside it.
 */
function withoutNullAgg<T extends ColumnSpec | SortSpec>(piece: T): T {
  if ((piece as { agg?: unknown }).agg !== null) return piece;
  const { agg: _agg, ...rest } = piece;
  return rest as T;
}

/** Every plain condition's path and every `exists`, through nested groups. */
function filterPaths(
  group: FilterGroup | undefined,
  out: { fields: string[]; relations: string[] } = { fields: [], relations: [] },
): { fields: string[]; relations: string[] } {
  for (const raw of group?.conditions ?? []) {
    const node = raw as FilterNode;
    if (!node || typeof node !== "object") continue;
    if (isFilterGroup(node)) filterPaths(node, out);
    else if (isExists(node)) out.relations.push(node.exists);
    else if (typeof (node as FilterCondition).path === "string") {
      out.fields.push((node as FilterCondition).path);
    }
  }
  return out;
}

const listOf = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

/**
 * How many pieces a configuration is made of, for saying what a prune cost.
 *
 * Filter conditions are counted at the top level only. A dropped group counts
 * as one however many conditions it held, so `omitted` under-reports rather
 * than over-reports — the client's message says "at least this much", which is
 * the safe direction for a number whose job is to stop a report opening
 * quietly narrower than it was saved.
 */
const elementCount = (config: ReportConfig): number =>
  listOf(config.columns).length +
  listOf(config.filters?.conditions).length +
  listOf(config.sort).length +
  listOf(config.groupBy).length;

/**
 * Everything gone, and the level of detail with it.
 *
 * The root is what the viewer may not have, so keeping it would leak the one
 * thing being withheld — and would let the client render a level of detail its
 * own catalog does not list. `label` and `description` are the author's words
 * and stay: they are what the listing shows, and blanking them would turn a
 * shared report into an unnameable row.
 */
const emptied = (config: ReportConfig): ReportConfig => ({
  ...config,
  root: "",
  columns: [],
  groupBy: [],
  sort: [],
  filters: { op: "and", conditions: [] },
});

/**
 * The catalog view, kept for each of the two answers `staff` can give.
 *
 * `buildCatalogView` walks the whole catalog graph: about half a millisecond,
 * which is nothing once per request and 45 ms when the listing prunes a hundred
 * saved reports one at a time. It is a pure function of the only thing that
 * varies here — the catalog itself is a module constant — so there are exactly
 * two possible results and both are worth keeping. Nothing below mutates them.
 */
const views = new Map<boolean, ReturnType<typeof buildCatalogView>>();

function viewFor(viewer: Viewer): ReturnType<typeof buildCatalogView> {
  const key = viewer.staff === true;
  let view = views.get(key);
  if (view === undefined) {
    view = buildCatalogView(viewer);
    views.set(key, view);
  }
  return view;
}

export interface PrunedConfig {
  config: ReportConfig;
  /** Pieces removed because this viewer may not use them. */
  omitted: number;
  /**
   * What the surviving paths *are*, for the ones the catalog's menu does not
   * list. The client draws every header, operator list and value box from the
   * catalog it downloaded; a path that is valid and absent from it would open
   * as a column with no name. Empty for nearly every report.
   */
  extraFields: CatalogFieldView[];
  /** The same, for to-many relations the report counts or filters on. */
  extraRelations: RelationView[];
}

/**
 * Keeps what this viewer may ask the builder for.
 *
 * Never throws. The listing prunes a page of reports in one answer, so one
 * stored configuration this could not read — and they are arbitrary JSON —
 * turned every reader's list of saved reports into a 500. A report that cannot
 * be read is handed over empty instead, with everything it had counted as
 * withheld.
 */
export function pruneConfig(config: ReportConfig, viewer: Viewer): PrunedConfig {
  try {
    return prune(config, viewer);
  } catch {
    const safe = config && typeof config === "object" ? config : ({} as ReportConfig);
    let omitted = 0;
    try { omitted = elementCount(safe); } catch { /* counted as nothing */ }
    return { config: emptied(safe), omitted, extraFields: [], extraRelations: [] };
  }
}

/**
 * A root that does not exist at all is left alone: the builder refuses it with a
 * sentence naming the level of detail, which is more use than an empty
 * configuration.
 *
 * A root that exists and is *hidden from this viewer* is the opposite case and
 * used to be indistinguishable from it, because the lookup below reads the
 * already-filtered view: both came out as `undefined` and both got the free
 * pass. That mattered the moment `usuario` became a `staffOnly` root, which is
 * to say the moment this module's whole purpose applied. An administrator saves
 * the per-person report this feature exists to enable, narrows it with a filter
 * on a phone number or a login name, marks it shared — and every account that
 * can list shared reports received the configuration verbatim: the hidden paths
 * *and the values filtered against them*, which is the personal data itself.
 * Running it was still refused, so the row never came back; the filter value did.
 * And `omitted: 0` told the client nothing had been withheld.
 *
 * So the two cases are separated: hidden means everything goes, and the count
 * says how much.
 */
function prune(config: ReportConfig, viewer: Viewer): PrunedConfig {
  const none = { extraFields: [], extraRelations: [] };
  if (!config || typeof config !== "object") return { config, omitted: 0, ...none };

  const root = viewFor(viewer).roots.find((r) => r.key === config.root);
  if (!root) {
    const real = typeof config.root === "string" && catalog.roots.includes(config.root);
    if (!real) return { config, omitted: 0, ...none };
    return { config: emptied(config), omitted: elementCount(config), ...none };
  }

  const valid = new Set(root.fields.map((f) => f.path));
  const listed = new Set(root.aggregateOnly.map((a) => a.path));

  /** A field: what a filter compares and what a report groups by. */
  const keepsField = (path: unknown): boolean =>
    typeof path === "string" && (valid.has(path) || hiddenField(root.key, path, viewer) !== null);
  /** A field or a to-many summary: what a column shows and an order sorts by. */
  const keeps = (path: unknown): boolean =>
    keepsField(path) || toManyOf(root.key, path, viewer) !== null;
  /**
   * Grouping by a hidden total is the one thing the description cannot rule
   * out and the builder does: «ya es un resumen». Menu fields keep the old
   * answer; only what this module newly lets through is asked about.
   */
  const keepsGroup = (path: unknown): boolean =>
    typeof path === "string" && (
      valid.has(path) ||
      (hiddenField(root.key, path, viewer) !== null &&
        builds({ root: root.key, columns: [{ path }], groupBy: [path] }, viewer))
    );

  const filters: FilterGroup =
    config.filters && typeof config.filters === "object"
      ? config.filters
      : { op: "and", conditions: [] };
  const columns = listOf(config.columns).filter((c) => c && keeps(c.path)).map(withoutNullAgg);
  const groupBy = listOf(config.groupBy).filter(keepsGroup);

  /**
   * An order whose column is in the report stays with it. One that never had a
   * column — the builder allows ordering a listing by a field it does not show
   * — is asked of the builder, over the smallest report with this grouping. It
   * used to be dropped for having no column, which is a rule of the screen and
   * not of the language.
   */
  const sortSurvives = (s: SortSpec): boolean => {
    if (!s || !keeps(s.path)) return false;
    if (columns.some((c) => c.path === s.path && sameAgg(c.agg, s.agg))) return true;
    const anchor = groupBy.length > 0 ? groupBy : root.fields.slice(0, 1).map((f) => f.path);
    return builds(
      { root: root.key, columns: anchor.map((path) => ({ path })), groupBy, sort: [s] },
      viewer,
    );
  };

  const pruned: ReportConfig = {
    ...config,
    columns,
    groupBy,
    sort: listOf(config.sort).filter(sortSurvives).map(withoutNullAgg),
    filters: {
      ...filters,
      conditions: listOf(filters.conditions).filter((c) =>
        nodeSurvives(c as FilterNode, keepsField, root.key, viewer),
      ),
    },
  };

  const inFilters = filterPaths(pruned.filters);
  const named = [...columns, ...(pruned.sort ?? [])].map((piece) => piece.path);

  const extraFields: CatalogFieldView[] = [];
  for (const path of new Set([...named, ...groupBy, ...inFilters.fields])) {
    if (valid.has(path)) continue;
    const field = hiddenField(root.key, path, viewer);
    if (field) extraFields.push(field);
  }

  const extraRelations = new Map<string, RelationView>();
  const offMenu = (relation: RelationView | null) => {
    if (relation && !listed.has(relation.path)) extraRelations.set(relation.path, relation);
  };
  for (const path of new Set(named)) offMenu(toManyOf(root.key, path, viewer));
  for (const path of new Set(inFilters.relations)) {
    const relation = describeToMany(root.key, path, viewer);
    offMenu(relation && { path: relation.path, label: relation.label, group: relation.group });
  }

  return {
    config: pruned,
    omitted: Math.max(0, elementCount(config) - elementCount(pruned)),
    extraFields,
    extraRelations: [...extraRelations.values()],
  };
}
