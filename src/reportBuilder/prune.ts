// Drops from a stored configuration whatever this viewer's catalog does not
// offer, on the way out of the server.
//
// Two defects with the same shape. `GET /reportes/:id` handed back the stored
// configuration verbatim, so a report shared by an administrator told every
// reader the paths of the fields the catalog hides from them — `usuario.user`
// among them — together with the values filtered against those fields. And
// `POST /reportes/:id/duplicar` validated that same configuration against the
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

import { catalog } from "./catalog.js";
import { buildCatalogView } from "./catalogView.js";
import { isExists, isFilterGroup, type FilterNode } from "./sqlBuilder.js";
import type { FilterCondition, FilterGroup, ReportConfig } from "./types.js";
import type { Viewer } from "./viewer.js";

/** Whether a whole filter node survives — all of it, or none of it. */
function nodeSurvives(node: FilterNode, keeps: (path: string) => boolean): boolean {
  // A stored configuration is JSON out of a database and can be any shape at
  // all, so anything malformed is dropped rather than inspected.
  if (!node || typeof node !== "object") return false;
  if (isFilterGroup(node)) {
    return (node.conditions ?? []).every((c) => nodeSurvives(c as FilterNode, keeps));
  }
  if (isExists(node)) {
    if (!keeps(node.exists)) return false;
    if (node.where === undefined) return true;
    return isFilterGroup(node.where) && nodeSurvives(node.where as FilterNode, keeps);
  }
  const { path } = node as FilterCondition;
  return typeof path === "string" && keeps(path);
}

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
  (Array.isArray(config.columns) ? config.columns.length : 0) +
  (config.filters?.conditions?.length ?? 0) +
  (config.sort?.length ?? 0) +
  (config.groupBy?.length ?? 0);

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
}

/**
 * Keeps only what this viewer's catalog offers.
 *
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
export function pruneConfig(config: ReportConfig, viewer: Viewer): PrunedConfig {
  if (!config || typeof config !== "object") return { config, omitted: 0 };

  const root = viewFor(viewer).roots.find((r) => r.key === config.root);
  if (!root) {
    const real = typeof config.root === "string" && catalog.roots.includes(config.root);
    if (!real) return { config, omitted: 0 };
    return { config: emptied(config), omitted: elementCount(config) };
  }

  const valid = new Set(root.fields.map((f) => f.path));
  const aggregable = new Set(root.aggregateOnly.map((a) => a.path));
  const keeps = (path: string) =>
    valid.has(path) ||
    aggregable.has(path) ||
    root.aggregateOnly.some((a) => path.startsWith(`${a.path}.`));

  const filters: FilterGroup = config.filters ?? { op: "and", conditions: [] };
  const columns = (Array.isArray(config.columns) ? config.columns : []).filter(
    (c) => c && typeof c.path === "string" && keeps(c.path),
  );
  const pruned: ReportConfig = {
    ...config,
    columns,
    groupBy: (config.groupBy ?? []).filter((path) => typeof path === "string" && keeps(path)),
    // A sort belongs to a column, so it goes when its column does.
    sort: (config.sort ?? []).filter(
      (s) => s && keeps(s.path) && columns.some((c) => c.path === s.path && c.agg === s.agg),
    ),
    filters: {
      ...filters,
      conditions: (filters.conditions ?? []).filter((c) =>
        nodeSurvives(c as FilterNode, keeps),
      ),
    },
  };

  return { config: pruned, omitted: Math.max(0, elementCount(config) - elementCount(pruned)) };
}
