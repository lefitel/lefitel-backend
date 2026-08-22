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

/** How many pieces a configuration is made of, for saying what a prune cost. */
const elementCount = (config: ReportConfig): number =>
  (Array.isArray(config.columns) ? config.columns.length : 0) +
  (config.filters?.conditions?.length ?? 0) +
  (config.sort?.length ?? 0) +
  (config.groupBy?.length ?? 0);

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
 * An unknown root is left alone: the builder refuses it with a sentence naming
 * the level of detail, which is more use than an empty configuration.
 */
export function pruneConfig(config: ReportConfig, viewer: Viewer): PrunedConfig {
  if (!config || typeof config !== "object") return { config, omitted: 0 };

  const root = viewFor(viewer).roots.find((r) => r.key === config.root);
  if (!root) return { config, omitted: 0 };

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
