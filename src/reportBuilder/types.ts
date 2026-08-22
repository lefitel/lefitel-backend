// Type definitions for the dynamic report builder.
//
// Design note: the catalog is the single source of truth. Nothing the user sends
// ever becomes an SQL identifier — paths are looked up here, and what gets written
// into the query is what this catalog declares.

export type FieldKind = "string" | "number" | "boolean" | "date" | "image";

/**
 * What a value *means*, beyond its type.
 *
 * The exporters need this to colour rows. They used to guess by looking for
 * "criticidad" inside the column label — a label the user can rename freely —
 * so a column called "Criticidad (count)" holding a count of 1 painted the row
 * catastrophic red.
 */
export type FieldSemantic = "criticality" | "state";

/** Comparison operators allowed in filters. Closed set, validated before use. */
export type Operator =
  | "eq" | "neq"
  | "gt" | "gte" | "lt" | "lte"
  | "between"
  | "in"
  | "like"
  | "isnull" | "notnull";

/** Aggregate functions allowed in summary mode. */
export type AggFn = "count" | "sum" | "avg" | "min" | "max";

export interface FieldDef {
  /** Physical column name. Always quoted when written into SQL. */
  column: string;
  kind: FieldKind;
  /** User-facing label, in Spanish. */
  label: string;
  /** Domain meaning, for presentation decisions such as row colour. */
  semantic?: FieldSemantic;
  /**
   * Set on the few columns that hold decimals — the coordinates, and nothing
   * else. Every other number in this catalog is an integer column, so a filter
   * carrying `2.5` is a value Postgres cannot read and the default has to be
   * the strict one: declaring the exception is the safe direction, because a
   * column that gains decimals and forgets this flag refuses a filter, while
   * the reverse leaks a 22P02 back to the user as "server broken".
   */
  decimals?: boolean;
  /**
   * Set on a field that holds another person's personal data. Only a viewer
   * with `seguridad.ver` sees it — the same permission that guards the screen
   * where that data lives. Absent means everybody who can open the generator.
   */
  staffOnly?: boolean;
}

/**
 * Relations come in three flavours and the distinction drives the whole engine:
 *
 * - `toOne`     belongsTo. Resolved with LEFT JOIN. Never multiplies rows.
 * - `toMany`    hasMany. Multiplies rows, so it is only reachable through
 *               aggregation (resolved as a correlated scalar subquery).
 * - `toOneLatest` hasMany in the schema but treated as one row by picking the
 *               most recent. Resolved with LEFT JOIN LATERAL. Used for
 *               `solucion` and `ultimaRevision`, which the existing reports
 *               already treat as single values.
 */
export type RelationKind = "toOne" | "toMany" | "toOneLatest";

export interface RelationDef {
  kind: RelationKind;
  /** Target entity key in the catalog. */
  target: string;
  label: string;
  /** For toOne: the FK column on the source entity. */
  localKey?: string;
  /**
   * The row has no meaning without this parent, so archiving the parent
   * archives it too.
   *
   * A paranoid `LEFT JOIN` only blanks the parent's columns; the child row
   * survives. That is right for an optional relation and wrong for a required
   * one: rooted at `revision`, 404 revisions of 138 archived events kept being
   * counted, and arrived in the listing with every event column empty, reading
   * as a data-quality problem rather than as records that were deleted.
   */
  required?: boolean;
  /** For toMany / toOneLatest: the FK column on the target entity. */
  foreignKey?: string;
  /** For toOneLatest: column used to pick the most recent row. */
  latestBy?: string;
  /** Set when the whole relation leads to personal data. See FieldDef. */
  staffOnly?: boolean;
}

/**
 * A calculated field is raw SQL built from the row's own aliases.
 * `deps` lists relation paths that must be joined for the expression to resolve.
 */
export interface CalculatedDef {
  kind: FieldKind;
  label: string;
  /** Relation paths (relative to the owning entity) that must be joined. */
  deps?: string[];
  /**
   * Builds the SQL expression.
   * @param alias   alias of the entity that owns this calculated field
   * @param dep     resolves a dependency path declared in `deps` to its alias
   */
  sql: (alias: string, dep: (path: string) => string) => string;
  /**
   * Expressions to GROUP BY when this field is grouped, when grouping by the
   * displayed value would be wrong. `tramo` renders city names but must group
   * by city ids: three cities in the data share a name, and grouping by text
   * would silently merge distinct tramos.
   *
   * Defaults to [sql] when absent.
   */
  groupKeys?: (alias: string, dep: (path: string) => string) => string[];
  /**
   * Set when the expression is itself an aggregate subquery, naming the inner
   * function. `numRevisiones` is a COUNT and therefore never null, so wrapping
   * it in COUNT() again would count rows instead of summing counts.
   */
  innerAgg?: AggFn;
  /** Domain meaning, for presentation decisions such as row colour. */
  semantic?: FieldSemantic;
  /** Set when the expression exposes personal data. See FieldDef. */
  staffOnly?: boolean;
}

export interface EntityDef {
  /** Physical table name. Verified against the live schema. */
  table: string;
  label: string;
  /** Whether the table has a deletedAt column. `rols` does not. */
  paranoid: boolean;
  fields: Record<string, FieldDef>;
  relations: Record<string, RelationDef>;
  calculated?: Record<string, CalculatedDef>;
}

export interface Catalog {
  entities: Record<string, EntityDef>;
  /** Entity keys usable as a query root. Each root defines what one row means. */
  roots: string[];
}

// ─── Report configuration (persisted as JSONB, sent by the client) ────────────

export interface ColumnSpec {
  /** Dotted path from the root, e.g. "poste.ciudadA.name". */
  path: string;
  /** Aggregate to apply. Required in summary mode unless the path is grouped. */
  agg?: AggFn;
  /** Header override. Falls back to the catalog label. */
  label?: string;
}

export interface FilterCondition {
  path: string;
  operator: Operator;
  /** Absent for isnull / notnull. Array for between / in. */
  value?: unknown;
}

/**
 * Existence test over a to-many relation.
 *
 * Reproduces what every current report does when it narrows events down to
 * those with at least one revision inside a date range, and generalises it:
 * "postes with a pending event", "eventos with a critical observation".
 *
 * `negate` turns it into NOT EXISTS.
 */
export interface ExistsCondition {
  exists: string;
  where?: FilterGroup;
  negate?: boolean;
}

export interface FilterGroup {
  op: "and" | "or";
  conditions: (FilterCondition | ExistsCondition | FilterGroup)[];
}

export interface SortSpec {
  path: string;
  dir: "asc" | "desc";
  agg?: AggFn;
}

export interface ReportConfig {
  root: string;
  columns: ColumnSpec[];
  filters?: FilterGroup;
  /** Empty means detail mode; non-empty switches to summary mode. */
  groupBy?: string[];
  sort?: SortSpec[];
  limit?: number;
  offset?: number;
}

// ─── Builder output ──────────────────────────────────────────────────────────

/** One output column of a report, as the client and the exporters see it. */
export interface ResultColumn {
  key: string;
  label: string;
  kind: FieldKind;
  semantic?: FieldSemantic;
}

export interface BuiltQuery {
  sql: string;
  binds: unknown[];
  /** Output columns in order, for the client to render headers. */
  columns: ResultColumn[];
}

export class ReportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportConfigError";
  }
}
