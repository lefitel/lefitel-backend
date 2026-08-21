// Translates a validated report configuration into parameterised SQL.
//
// Security model: no user-supplied string ever becomes an SQL identifier.
// Paths are looked up in the catalog and what gets written is what the catalog
// declares. Values always travel as bind parameters. Operators come from a
// closed set. Errors carry user-facing Spanish messages, because they surface
// directly in the report builder UI.

import { catalog, MAX_DEPTH, MAX_ROWS, REPORT_TIME_ZONE } from "./catalog.js";
import {
  AGGS_BY_KIND,
  AGG_LABEL,
  KIND_LABEL,
  OPERATORS_BY_KIND,
  OPERATOR_LABEL,
} from "./constraints.js";
import {
  ReportConfigError,
  type AggFn,
  type BuiltQuery,
  type ColumnSpec,
  type EntityDef,
  type FieldKind,
  type ExistsCondition,
  type FilterCondition,
  type FieldSemantic,
  type FilterGroup,
  type Operator,
  type ReportConfig,
} from "./types.js";

const AGG_FNS: AggFn[] = ["count", "sum", "avg", "min", "max"];

/**
 * Width limits. MAX_ROWS bounds how many rows come back; nothing bounded how
 * WIDE a report could be. 1600 aggregate columns fit in a 74 KB request and
 * produced 1600 correlated subqueries, 70 MB of JSON and 15 s of database CPU.
 */
export const MAX_COLUMNS = 60;
/**
 * Header length. Unbounded labels are not just untidy: 60 columns of 300
 * characters each make jspdf-autotable's pagination stop converging, so a
 * shared report can freeze the tab of everyone who exports it.
 */
const MAX_LABEL = 120;
export const MAX_SORTS = 10;
export const MAX_CONDITIONS = 100;

const OPERATORS: Operator[] = [
  "eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "like", "isnull", "notnull",
];

/** Operators that need no value at all. */
const NULLARY_OPERATORS: Operator[] = ["isnull", "notnull"];

/** Identifiers only ever come from the catalog, but assert it rather than trust it. */
const quote = (identifier: string): string => {
  // typeof check first: /re/.test(undefined) stringifies to "undefined" and
  // passes, which would let a prototype lookup emit a bogus identifier.
  if (typeof identifier !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new ReportConfigError(`Identificador no válido en el catálogo: ${identifier}`);
  }
  return `"${identifier}"`;
};

const isVisible = (roles: number[] | undefined, role: number): boolean =>
  roles === undefined || roles.includes(role);

interface ResolvedExpr {
  /** SQL expression producing the value. */
  sql: string;
  kind: FieldKind;
  label: string;
  /** True when the expression already aggregates (a correlated subquery). */
  selfAggregating: boolean;
  /** Which aggregate the subquery uses, when it is one. */
  innerAgg?: AggFn;
  /**
   * True when the expression is a total belonging to another entity, reached
   * through a relation.
   *
   * Such a value repeats once per row of the root, so summarising it counts the
   * same subquery over and over: a poste with *n* events contributed *n²*, and
   * "Total de eventos" read 75 beside a `COUNT` of 73 on the very same line.
   */
  foreignGrain?: boolean;
  /** Expressions to GROUP BY when grouping by this value; defaults to [sql]. */
  groupKeys?: string[];
  /** Domain meaning, forwarded to the client for presentation. */
  semantic?: FieldSemantic;
}

/**
 * Collects the JOINs a query needs, one per distinct relation path, so two
 * columns sharing a prefix share a join. Aliases are deterministic, which makes
 * the generated SQL stable and readable when debugging.
 */
class JoinPlan {
  private readonly aliases = new Map<string, string>();
  private readonly clauses: string[] = [];
  private counter = 0;

  /**
   * @param rootAlias   alias of the FROM table
   * @param aliasPrefix prefix for join aliases; subqueries use their own so
   *                    inner joins can never collide with the outer query's
   */
  constructor(readonly rootAlias: string, private readonly aliasPrefix = "t") {}

  has(path: string): boolean {
    return this.aliases.has(path);
  }

  get(path: string): string {
    const alias = this.aliases.get(path);
    if (!alias) throw new ReportConfigError(`Relación no resuelta: ${path}`);
    return alias;
  }

  add(path: string, buildClause: (alias: string) => string): string {
    const existing = this.aliases.get(path);
    if (existing) return existing;
    const alias = `${this.aliasPrefix}${++this.counter}`;
    this.aliases.set(path, alias);
    this.clauses.push(buildClause(alias));
    return alias;
  }

  toSql(): string {
    return this.clauses.join("\n");
  }
}

/** Own-property lookup: plain member access would resolve `constructor`, `toString`… */
const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  typeof key === "string" && Object.hasOwn(record, key) ? record[key] : undefined;

const entityOrThrow = (key: string): EntityDef => {
  const entity = own(catalog.entities, key);
  if (!entity) throw new ReportConfigError(`Entidad desconocida: ${key}`);
  return entity;
};

/** Appends the paranoid guard for tables that have a deletedAt column. */
const notDeleted = (entity: EntityDef, alias: string): string =>
  entity.paranoid ? ` AND ${alias}.${quote("deletedAt")} IS NULL` : "";

/**
 * Excludes rows whose required parent has been archived.
 *
 * The root's own `deletedAt IS NULL` is not enough: a revision belongs to an
 * event, and archiving the event archives the revision in every sense a report
 * cares about. A paranoid `LEFT JOIN` cannot express that — it blanks the
 * parent's columns and keeps the row — and the join only exists at all when the
 * report happens to mention the parent, so the guard has to be unconditional.
 *
 * Rooted at `revision` this was 404 rows of 138 archived events, and at
 * `eventoObs` 141 of 1.563: counted in every total, and shown in the listing
 * with every event column empty, which reads as missing data rather than as
 * records someone deleted on purpose.
 */
function requiredParentGuards(entity: EntityDef, alias: string): string {
  let sql = "";
  for (const relation of Object.values(entity.relations)) {
    if (!relation.required || relation.kind !== "toOne" || !relation.localKey) continue;
    const parent = entityOrThrow(relation.target);
    if (!parent.paranoid) continue;
    sql +=
      ` AND EXISTS (SELECT 1 FROM ${quote(parent.table)} p` +
      ` WHERE p.${quote("id")} = ${alias}.${quote(relation.localKey)}` +
      `${notDeleted(parent, "p")})`;
  }
  return sql;
}

/**
 * Walks a chain of to-one relations, registering the JOINs it needs, and
 * returns where it landed. Stops before the final segment, which is the field.
 */
function walkToOne(
  rootEntity: EntityDef,
  segments: string[],
  plan: JoinPlan,
  role: number,
  fullPath: string,
): { entity: EntityDef; alias: string } {
  let entity = rootEntity;
  let alias = plan.rootAlias;
  let prefix = "";

  segments.forEach((segment, index) => {
    const relation = own(entity.relations, segment);
    if (!relation) {
      throw new ReportConfigError(`El campo "${fullPath}" no existe en el catálogo.`);
    }
    if (!isVisible(relation.roles, role)) {
      throw new ReportConfigError(`No tiene permiso para usar "${fullPath}".`);
    }
    if (relation.kind === "toMany") {
      throw new ReportConfigError(
        `"${fullPath}" atraviesa una relación de varios registros. ` +
          `Use un resumen (conteo, promedio…) o cambie el nivel de detalle del reporte.`,
      );
    }
    if (index + 1 > MAX_DEPTH) {
      throw new ReportConfigError(
        `El campo "${fullPath}" está demasiado anidado (máximo ${MAX_DEPTH} niveles).`,
      );
    }

    const target = entityOrThrow(relation.target);
    prefix = prefix ? `${prefix}.${segment}` : segment;
    const parentAlias = alias;

    alias = plan.add(prefix, (newAlias) => {
      if (relation.kind === "toOneLatest") {
        // hasMany in the schema, but the existing reports treat it as a single
        // value. LATERAL picks the most recent row without multiplying rows.
        const fk = quote(relation.foreignKey!);
        const order = quote(relation.latestBy!);
        // Project only catalogued columns instead of SELECT *, and break ties
        // by id: five events have two solutions with byte-identical dates, and
        // without a tiebreaker which one shows depends on the query plan.
        const projected = [...new Set([
          "id",
          ...Object.values(target.fields).map((f) => f.column),
          relation.latestBy!,
          // The keys the target's own to-one relations join on. Projecting only
          // the catalogued fields left them out, so every path that hopped
          // onward from here — `ultimaRevision.evento.*`, 62 of the 245 pairs
          // the catalog advertises — joined against a column this subquery does
          // not return. The picker offered them, saving validated them, and
          // running one answered 500 for good.
          ...Object.values(target.relations ?? {})
            .map((r) => r.localKey)
            .filter((key): key is string => typeof key === "string"),
        ])].map((c) => `x.${quote(c)}`).join(", ");
        return (
          `LEFT JOIN LATERAL (SELECT ${projected} FROM ${quote(target.table)} x` +
          ` WHERE x.${fk} = ${parentAlias}.${quote("id")}` +
          `${notDeleted(target, "x")}` +
          ` ORDER BY x.${order} DESC NULLS LAST, x.${quote("id")} DESC LIMIT 1) ${newAlias} ON true`
        );
      }
      const localKey = quote(relation.localKey!);
      return (
        `LEFT JOIN ${quote(target.table)} ${newAlias}` +
        ` ON ${newAlias}.${quote("id")} = ${parentAlias}.${localKey}` +
        `${notDeleted(target, newAlias)}`
      );
    });

    entity = target;
  });

  return { entity, alias };
}

/** Builds a correlated scalar subquery for an aggregate over a to-many relation. */
function buildToManyAggregate(
  parentEntity: EntityDef,
  parentAlias: string,
  relationName: string,
  fieldName: string | undefined,
  agg: AggFn,
  role: number,
  fullPath: string,
): ResolvedExpr {
  const relation = own(parentEntity.relations, relationName);
  if (!relation || relation.kind !== "toMany") {
    throw new ReportConfigError(`"${fullPath}" no es una relación de varios registros.`);
  }
  if (!isVisible(relation.roles, role)) {
    throw new ReportConfigError(`No tiene permiso para usar "${fullPath}".`);
  }

  const target = entityOrThrow(relation.target);
  const fk = quote(relation.foreignKey!);
  const where =
    `WHERE s.${fk} = ${parentAlias}.${quote("id")}${notDeleted(target, "s")}`;

  if (agg === "count" && !fieldName) {
    return {
      sql: `(SELECT COUNT(*) FROM ${quote(target.table)} s ${where})`,
      kind: "number",
      label: `Nº de ${relation.label.toLowerCase()}`,
      selfAggregating: true,
      innerAgg: "count",
    };
  }

  if (!fieldName) {
    throw new ReportConfigError(
      `El resumen "${agg}" sobre "${relation.label}" necesita indicar un campo.`,
    );
  }

  const field = own(target.fields, fieldName);
  if (!field) {
    throw new ReportConfigError(`El campo "${fullPath}" no existe en el catálogo.`);
  }
  if (!isVisible(field.roles, role)) {
    throw new ReportConfigError(`No tiene permiso para usar "${fullPath}".`);
  }

  const fn = agg.toUpperCase();
  return {
    sql: `(SELECT ${fn}(s.${quote(field.column)}) FROM ${quote(target.table)} s ${where})`,
    kind: agg === "count" ? "number" : field.kind,
    label: `${field.label} (${agg})`,
    selfAggregating: true,
    innerAgg: agg,
  };
}

/**
 * Resolves a dotted path into an SQL expression.
 *
 * Three shapes are supported:
 *   evento.poste.name        chain of to-one relations ending in a field
 *   diasAbierto              calculated field on the entity reached so far
 *   revisiones / revisiones.date   to-many relation, only with an aggregate
 */
function resolvePath(
  rootEntity: EntityDef,
  path: string,
  plan: JoinPlan,
  role: number,
  agg?: AggFn,
): ResolvedExpr {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ReportConfigError("Hay una columna sin campo seleccionado.");
  }

  const segments = path.split(".");
  if (segments.some((s) => s === "")) {
    throw new ReportConfigError(`Ruta de campo mal formada: "${path}".`);
  }
  if (segments.length - 1 > MAX_DEPTH) {
    throw new ReportConfigError(
      `El campo "${path}" está demasiado anidado (máximo ${MAX_DEPTH} niveles).`,
    );
  }

  // Locate a to-many hop, if any. Everything before it must be to-one.
  let entity = rootEntity;
  for (let i = 0; i < segments.length; i++) {
    const relation = own(entity.relations, segments[i]);
    if (relation?.kind === "toMany") {
      const prefix = segments.slice(0, i);
      const rest = segments.slice(i + 1);
      if (rest.length > 1) {
        throw new ReportConfigError(
          `"${path}" es demasiado profundo tras una relación de varios registros.`,
        );
      }
      if (!agg) {
        throw new ReportConfigError(
          `"${relation.label}" tiene varios registros por fila. ` +
            `Elija un resumen (conteo, promedio…) o cambie el nivel de detalle.`,
        );
      }
      const landing = walkToOne(rootEntity, prefix, plan, role, path);
      const resolved = buildToManyAggregate(
        landing.entity, landing.alias, segments[i], rest[0], agg, role, path,
      );
      // A to-many total reached *through* a relation counts at that relation's
      // grain, not the report's. `poste.eventos` on a report of events asks the
      // poste how many events it has, and reads that same answer once per event
      // of that poste — summing it squares the number. The guard existed only
      // for the calculated-field spelling of the same total (`poste.numEventos`)
      // and this path walked straight past it: 1.390 events reported where 1.376
      // exist, and 91.195 revisions where 7.337 exist.
      return { ...resolved, foreignGrain: prefix.length > 0 };
    }
    if (!relation) break;
    entity = entityOrThrow(relation.target);
  }

  // Plain chain: walk the relations, resolve the last segment as a field.
  const leaf = segments[segments.length - 1];
  const landing = walkToOne(rootEntity, segments.slice(0, -1), plan, role, path);
  const target = landing.entity;

  const field = own(target.fields, leaf);
  if (field) {
    if (!isVisible(field.roles, role)) {
      throw new ReportConfigError(`No tiene permiso para usar "${path}".`);
    }
    return {
      sql: `${landing.alias}.${quote(field.column)}`,
      kind: field.kind,
      label: field.label,
      selfAggregating: false,
      // A plain column of a parent has the same grain problem its calculated
      // siblings do: read once per row of this report, so adding the readings
      // up counts a poste's number once for every event of that poste. Only
      // `sum` is affected — see `inflatesAcrossRows`.
      foreignGrain: segments.length > 1,
      semantic: field.semantic,
    };
  }

  const calculated = target.calculated ? own(target.calculated, leaf) : undefined;
  if (calculated) {
    if (!isVisible(calculated.roles, role)) {
      throw new ReportConfigError(`No tiene permiso para usar "${path}".`);
    }
    // Calculated fields may need extra joins; register them relative to the
    // path we landed on so aliases stay shared with the rest of the query.
    const basePath = segments.slice(0, -1).join(".");
    const dep = (depPath: string): string => {
      const absolute = basePath ? `${basePath}.${depPath}` : depPath;
      if (!plan.has(absolute)) {
        walkToOne(rootEntity, absolute.split("."), plan, role, path);
      }
      return plan.get(absolute);
    };
    for (const depPath of calculated.deps ?? []) dep(depPath);

    return {
      sql: calculated.sql(landing.alias, dep),
      kind: calculated.kind,
      label: calculated.label,
      // A calculated field that is itself an aggregate subquery needs the same
      // treatment as a to-many aggregate when it is summarised.
      selfAggregating: calculated.innerAgg !== undefined,
      innerAgg: calculated.innerAgg,
      // A non-empty base path means the value was reached through a relation,
      // so it belongs to that entity's grain rather than the report's.
      //
      // This used to require `innerAgg`, which meant only the counts were
      // caught. Every calculated field that is a per-parent scalar walked past
      // it: over a report of revisions grouped by state, `SUM(evento.diasAbierto)`
      // returned 1.026.699 where the honest number — each event counted once —
      // is 103.323. Ten times, under a header that names no grain at all.
      foreignGrain: basePath !== "",
      semantic: calculated.semantic,
      groupKeys: calculated.groupKeys?.(landing.alias, dep),
    };
  }

  throw new ReportConfigError(`El campo "${path}" no existe en el catálogo.`);
}

// ─── Filters ─────────────────────────────────────────────────────────────────

type FilterNode = FilterCondition | ExistsCondition | FilterGroup;

const isFilterGroup = (node: FilterNode): node is FilterGroup =>
  typeof (node as FilterGroup).op === "string" &&
  Array.isArray((node as FilterGroup).conditions);

const isExists = (node: FilterNode): node is ExistsCondition =>
  typeof (node as ExistsCondition).exists === "string";

/**
 * Builds an EXISTS test over a to-many relation.
 *
 * The inner conditions are resolved against the related entity as its own root,
 * with its own alias space, so nested paths inside `where` cannot leak out.
 */
function buildExists(
  node: ExistsCondition,
  rootEntity: EntityDef,
  plan: JoinPlan,
  role: number,
  binds: unknown[],
  depth: number,
): string {
  if (depth > MAX_DEPTH) {
    throw new ReportConfigError("El filtro de existencia está demasiado anidado.");
  }

  const segments = node.exists.split(".");
  if (segments.some((s) => s === "")) {
    throw new ReportConfigError(`Filtro de existencia mal formado: "${node.exists}".`);
  }

  const relationName = segments[segments.length - 1];
  const landing = walkToOne(rootEntity, segments.slice(0, -1), plan, role, node.exists);
  const relation = own(landing.entity.relations, relationName);

  if (!relation || relation.kind !== "toMany") {
    throw new ReportConfigError(
      `"${node.exists}" no es una relación de varios registros; use un filtro normal.`,
    );
  }
  if (!isVisible(relation.roles, role)) {
    throw new ReportConfigError(`No tiene permiso para usar "${node.exists}".`);
  }

  const target = entityOrThrow(relation.target);
  const innerPlan = new JoinPlan(`e${depth}`, `e${depth}_j`);
  const conditions = [
    `${innerPlan.rootAlias}.${quote(relation.foreignKey!)} = ${landing.alias}.${quote("id")}`,
  ];
  if (target.paranoid) {
    conditions.push(`${innerPlan.rootAlias}.${quote("deletedAt")} IS NULL`);
  }

  if (node.where) {
    const innerSql = buildFilters(node.where, target, innerPlan, role, binds, depth + 1);
    if (innerSql) conditions.push(innerSql);
  }

  const sql =
    `SELECT 1 FROM ${quote(target.table)} ${innerPlan.rootAlias}` +
    `${innerPlan.toSql() ? ` ${innerPlan.toSql()}` : ""}` +
    ` WHERE ${conditions.join(" AND ")}`;

  return node.negate === true ? `NOT EXISTS (${sql})` : `EXISTS (${sql})`;
}

/** A bare calendar day, with no time component. */
const isPlainDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** How long a single filter value may be. Longer than any real search term. */
const MAX_FILTER_VALUE = 200;

/**
 * Refuses a value the column cannot hold, before it becomes a bind.
 *
 * The operator was checked against the field's kind and the value was not, so
 * `{"path":"id","operator":"eq","value":"abc"}` built valid SQL and Postgres
 * answered 22P02. That matters more than it sounds: saving a report validates
 * by building this same SQL, so such a report saved *cleanly* and then failed
 * on every run afterwards — for its author and for everyone it was shared
 * with — as a 500 that reads like the server is broken. Nine shapes did it,
 * including `{}` and `[1,2]` on a number, "si" on a boolean and any text on a
 * date.
 *
 * Objects are refused outright: nothing legitimate sends one, and a value that
 * is not a scalar is the shape an injection attempt takes.
 */
function checkValue(value: unknown, kind: FieldKind, label: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    throw new ReportConfigError(`El filtro sobre "${label}" tiene un valor no válido.`);
  }
  if (typeof value === "string" && value.length > MAX_FILTER_VALUE) {
    throw new ReportConfigError(
      `El valor del filtro sobre "${label}" es demasiado largo ` +
        `(máximo ${MAX_FILTER_VALUE} caracteres).`,
    );
  }

  switch (kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(n) || String(value).trim() === "") {
        throw new ReportConfigError(`El filtro sobre "${label}" necesita un número.`);
      }
      // Beyond this Postgres refuses the bind as out of range for bigint, and
      // JavaScript has already stopped counting exactly.
      if (!Number.isSafeInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) {
        throw new ReportConfigError(`El número del filtro sobre "${label}" está fuera de rango.`);
      }
      return;
    }
    case "date": {
      if (value instanceof Date) return;
      if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
        throw new ReportConfigError(`El filtro sobre "${label}" necesita una fecha.`);
      }
      return;
    }
    case "boolean": {
      if (typeof value === "boolean") return;
      if (value === "true" || value === "false") return;
      throw new ReportConfigError(`El filtro sobre "${label}" sólo admite sí o no.`);
    }
    default: {
      if (typeof value !== "string") {
        throw new ReportConfigError(`El filtro sobre "${label}" necesita un texto.`);
      }
    }
  }
}

/**
 * Refuses a filter tree carrying more conditions than a report may have.
 *
 * The cap was applied to each group on its own while the message it threw said
 * "el reporte tiene demasiados filtros" — so a hundred groups of a hundred
 * conditions each passed cleanly: ten thousand conditions and four thousand
 * correlated subqueries, in a request body small enough that nothing else
 * objected. The number the message promises is the number now enforced.
 */
function checkTotalConditions(node: FilterNode, seen = { total: 0 }): void {
  // `isFilterGroup` reads a property, so it needs an object; the malformed
  // nodes are counted and left for the builder to reject with a sentence.
  const shaped = Boolean(node) && typeof node === "object";
  if (shaped && isFilterGroup(node)) {
    for (const child of node.conditions ?? []) checkTotalConditions(child, seen);
  } else {
    seen.total += 1;
    if (shaped && isExists(node)) {
      const where = (node as ExistsCondition).where;
      if (where) checkTotalConditions(where, seen);
    }
  }
  if (seen.total > MAX_CONDITIONS) {
    throw new ReportConfigError(`El reporte tiene demasiados filtros (máximo ${MAX_CONDITIONS}).`);
  }
}

function buildCondition(
  condition: FilterCondition,
  rootEntity: EntityDef,
  plan: JoinPlan,
  role: number,
  binds: unknown[],
): string {
  if (!condition || typeof condition !== "object") {
    throw new ReportConfigError("Hay un filtro vacío o mal formado.");
  }
  if (!OPERATORS.includes(condition.operator)) {
    throw new ReportConfigError(`Operador no permitido: ${String(condition.operator)}`);
  }

  const resolved = resolvePath(rootEntity, condition.path, plan, role);
  const expr = resolved.sql;
  const { operator, value } = condition;

  // The catalog advertises which operators fit each type; enforce it here too,
  // or an invalid filter reaches Postgres and returns a raw type error.
  if (!OPERATORS_BY_KIND[resolved.kind]?.includes(operator)) {
    throw new ReportConfigError(
      `No se puede filtrar "${resolved.label}" con "${OPERATOR_LABEL[operator]}" ` +
        `porque es un campo de tipo ${KIND_LABEL[resolved.kind]}.`,
    );
  }

  if (NULLARY_OPERATORS.includes(operator)) {
    return operator === "isnull" ? `${expr} IS NULL` : `${expr} IS NOT NULL`;
  }

  if (value === undefined || value === null) {
    throw new ReportConfigError(`El filtro sobre "${resolved.label}" no tiene valor.`);
  }

  // A list belongs to the two operators that take one. Anywhere else an array
  // binds as a Postgres array literal against a scalar column — `{"1","2"}`
  // against an integer — which is a 500 the caller cannot read.
  if (Array.isArray(value) && operator !== "between" && operator !== "in") {
    throw new ReportConfigError(
      `El filtro "${OPERATOR_LABEL[operator]}" sobre "${resolved.label}" necesita un solo valor.`,
    );
  }

  // Every value, including each end of a range and each entry of a list. The
  // array wrappers themselves are shape-checked by their own operators below.
  for (const single of Array.isArray(value) ? value : [value]) {
    checkValue(single, resolved.kind, resolved.label);
  }

  const bind = (v: unknown): string => {
    binds.push(v);
    return `$${binds.length}`;
  };

  /**
   * The instant a calendar day begins, and the instant the next one does, in
   * the zone every report is read in.
   *
   * Every date column is `timestamp with time zone`. `timestamp AT TIME ZONE
   * zone` reads a wall clock in that zone and yields the instant it stands for,
   * so "el 23 de mayo" means the day the report prints rather than the day the
   * database session happens to be in — those disagreed for 26% of the events.
   * Converting the bounds and not the column is deliberate: it leaves the
   * column bare, so an index on it still applies.
   *
   * The `::timestamp` cast is the whole point and must not be tidied away.
   * `AT TIME ZONE` has two overloads, and a bare `date` can reach either one.
   * Postgres prefers `timestamptz` inside the datetime category, so
   * `$1::date AT TIME ZONE 'America/La_Paz'` resolves to the *rendering*
   * overload: it reads the date as an instant in the session's zone and
   * converts it to a wall clock in La Paz. Under a UTC session that lands on
   * 20:00 of the previous day — the lower bound of every range fell 8 hours
   * early, and a one-day filter spanned 32 hours starting at 16:00 the day
   * before. Asking for events of 17/01/2026 returned 63 where 4 occurred.
   * Casting to `timestamp` first pins the intended overload, and then the
   * bound is identical under any session zone.
   *
   * `dayEnd` was already correct by accident: `date + interval` is already a
   * `timestamp`, so it never reached the other overload. The cast is written
   * out anyway, so the two read as the pair they are.
   */
  const dayStart = (v: unknown) =>
    `((${bind(v)}::date)::timestamp AT TIME ZONE '${REPORT_TIME_ZONE}')`;
  const dayEnd = (v: unknown) =>
    `((${bind(v)}::date + interval '1 day')::timestamp AT TIME ZONE '${REPORT_TIME_ZONE}')`;
  const isDate = resolved.kind === "date";

  switch (operator) {
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new ReportConfigError(
          `El filtro "entre" sobre "${resolved.label}" necesita dos valores.`,
        );
      }
      if (isDate) {
        // Each end on its own: the client sends plain dates, but a stored
        // configuration may carry a full instant on one side. A plain date
        // closes on the next midnight, an instant closes on itself.
        const from = isPlainDate(value[0]) ? dayStart(value[0]) : bind(value[0]);
        const closes = isPlainDate(value[1]) ? "<" : "<=";
        const to = isPlainDate(value[1]) ? dayEnd(value[1]) : bind(value[1]);
        return `${expr} >= ${from} AND ${expr} ${closes} ${to}`;
      }
      return `${expr} BETWEEN ${bind(value[0])} AND ${bind(value[1])}`;
    }
    case "in": {
      if (!Array.isArray(value) || value.length === 0) {
        throw new ReportConfigError(
          `El filtro "en la lista" sobre "${resolved.label}" necesita al menos un valor.`,
        );
      }
      if (value.some((v) => v !== null && typeof v === "object")) {
        throw new ReportConfigError(
          `El filtro "en la lista" sobre "${resolved.label}" tiene valores no válidos.`,
        );
      }
      return `${expr} = ANY(${bind(value)})`;
    }
    case "like": {
      if (typeof value !== "string") {
        throw new ReportConfigError(`El filtro de texto sobre "${resolved.label}" no es válido.`);
      }
      // The wildcards belong to the operator, not to what a person typed:
      // unescaped, "contiene %" matched every row and "contiene a_e" matched
      // "abe". The backslash has to be escaped first or it would escape the
      // escapes.
      const literal = value.replace(/[\\%_]/g, "\\$&");
      return `${expr} ILIKE ${bind(`%${literal}%`)} ESCAPE '\\'`;
    }
    // Whole-day semantics on timestamp columns: "on this day", "up to and
    // including this day", "strictly after this day".
    case "eq":
      if (isDate && isPlainDate(value)) {
        return `${expr} >= ${dayStart(value)} AND ${expr} < ${dayEnd(value)}`;
      }
      return `${expr} = ${bind(value)}`;
    case "lte":
      if (isDate && isPlainDate(value)) return `${expr} < ${dayEnd(value)}`;
      return `${expr} <= ${bind(value)}`;
    case "gt":
      if (isDate && isPlainDate(value)) return `${expr} >= ${dayEnd(value)}`;
      return `${expr} > ${bind(value)}`;
    case "neq":
      // NULL <> value is NULL, which silently turns a LEFT JOIN into an INNER
      // JOIN and drops rows the user never asked to exclude.
      if (isDate && isPlainDate(value)) {
        // The exact complement of `eq`, or the two do not partition the set:
        // "distinta del 24 de mayo" has to exclude that whole day, and it used
        // to exclude a single instant of it and so excluded nothing at all.
        return `(${expr} IS NULL OR ${expr} < ${dayStart(value)} OR ${expr} >= ${dayEnd(value)})`;
      }
      return `${expr} IS DISTINCT FROM ${bind(value)}`;
    // "From this day on" and "before this day". Both were falling through to a
    // default that ignored `isDate` entirely, so the bare date was compared as
    // an instant in the session's zone: four hours off, and inconsistent with
    // their own partners — `lte` covered the whole day while `lt` did not, and
    // `gt` covered it while `gte` did not.
    case "gte":
      if (isDate && isPlainDate(value)) return `${expr} >= ${dayStart(value)}`;
      return `${expr} >= ${bind(value)}`;
    case "lt":
      if (isDate && isPlainDate(value)) return `${expr} < ${dayStart(value)}`;
      return `${expr} < ${bind(value)}`;
    default:
      // The operator set is closed and checked against the field's kind above,
      // so this is unreachable — and an unreachable branch that builds SQL out
      // of an unknown operator is how a silent `undefined` reaches Postgres.
      throw new ReportConfigError(
        `El operador "${String(operator)}" no está permitido sobre "${resolved.label}".`,
      );
  }
}

function buildFilters(
  group: FilterGroup,
  rootEntity: EntityDef,
  plan: JoinPlan,
  role: number,
  binds: unknown[],
  depth = 0,
): string {
  if (depth > MAX_DEPTH * 2) {
    throw new ReportConfigError("Los filtros del reporte están demasiado anidados.");
  }
  if (group.op !== "and" && group.op !== "or") {
    throw new ReportConfigError(`Combinación de filtros no válida: ${String(group.op)}`);
  }
  const conditions = group.conditions ?? [];
  if (!Array.isArray(conditions)) {
    throw new ReportConfigError("Los filtros del reporte no son válidos.");
  }
  // Once, over the whole tree, from the outermost call: counting again inside
  // every nested group would walk the same subtrees over and over.
  if (depth === 0) checkTotalConditions(group);
  const parts = conditions.map((node) => {
    if (!node || typeof node !== "object") {
      throw new ReportConfigError("Hay un filtro vacío o mal formado.");
    }
    // depth + 1 for nested groups too: it used to bound only EXISTS, so deeply
    // nested groups blew the call stack.
    if (isFilterGroup(node)) return buildFilters(node, rootEntity, plan, role, binds, depth + 1);
    if (isExists(node)) return buildExists(node, rootEntity, plan, role, binds, depth);
    return buildCondition(node, rootEntity, plan, role, binds);
  });
  const meaningful = parts.filter((p) => p.trim() !== "");
  if (meaningful.length === 0) return "";
  return `(${meaningful.join(group.op === "and" ? " AND " : " OR ")})`;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Wraps an expression in an aggregate for summary mode.
 *
 * A to-many aggregate is already a correlated scalar subquery, and such a
 * subquery is never NULL. COUNT() over it therefore counts root rows rather
 * than summing the inner counts, which silently reports the number of events
 * where the user asked for the number of revisions. AVG() over it produces an
 * unweighted average of averages, which is a different number from the average
 * the user means, so it is rejected instead of quietly answering wrong.
 */
/**
 * Does this summary multiply a value that belongs to another entity?
 *
 * A parent value is read once per child row, and what that costs depends on the
 * summary asked for:
 *
 * - `sum` always multiplies. A poste with ten events contributes its number ten
 *   times: `SUM(evento.diasAbierto)` over revisions returned 1.026.699 where the
 *   honest figure is 103.323.
 * - `count` only multiplies when the expression is already a counting
 *   subquery, because `applyAggregate` turns that pair into `SUM` — which is the
 *   n² case. Counting a plain parent attribute counts the report's own rows and
 *   is not inflated at all; refusing it took away `COUNT(poste.tramo)`, which
 *   was answering correctly.
 * - `min` and `max` do not care: the largest of a value repeated ten times is
 *   that value. Refusing them deleted reports that were right.
 * - `avg` never gets here for a subquery — `applyAggregate` refuses an average
 *   of averages on its own. Over a plain parent attribute it is an average
 *   weighted by how many children each parent has, which is a different number
 *   from the one most people mean and is left alone for now.
 */
function inflatesAcrossRows(resolved: ResolvedExpr, agg: AggFn): boolean {
  if (!resolved.foreignGrain) return false;
  if (agg === "sum") return true;
  return agg === "count" && resolved.selfAggregating;
}

function applyAggregate(expr: string, agg: AggFn, resolved: ResolvedExpr): string {
  if (!resolved.selfAggregating) return `${agg.toUpperCase()}(${expr})`;

  // The inner aggregate decides what the outer one may mean.
  if (agg === "count") {
    // A COUNT subquery is never null, so COUNT() over it would just count the
    // group's rows. Summing the per-row counts is what the user asked for.
    return resolved.innerAgg === "count" ? `SUM(${expr})` : `COUNT(${expr})`;
  }
  if (agg === "avg" && resolved.innerAgg === "avg") {
    // Averaging per-row averages weighs a row with one child the same as one
    // with ten, which is a different number from the average being asked for.
    throw new ReportConfigError(
      `El promedio de "${resolved.label}" no se puede calcular por grupo ` +
        `porque ya es un promedio por fila. Use la suma, el mínimo o el máximo.`,
    );
  }
  return `${agg.toUpperCase()}(${expr})`;
}

/**
 * Builds the SQL for a report configuration.
 *
 * Pure function: same config and role always produce the same SQL and binds,
 * which is what makes the engine testable without a database.
 */
export function buildQuery(config: ReportConfig, role: number): BuiltQuery {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ReportConfigError("La configuración del reporte no es válida.");
  }
  if (!catalog.roots.includes(config.root)) {
    throw new ReportConfigError(
      `"${String(config.root)}" no es un nivel de detalle válido para un reporte.`,
    );
  }
  if (!Array.isArray(config.columns) || config.columns.length === 0) {
    throw new ReportConfigError("El reporte necesita al menos una columna.");
  }
  if (config.columns.length > MAX_COLUMNS) {
    throw new ReportConfigError(
      `El reporte tiene demasiadas columnas (máximo ${MAX_COLUMNS}).`,
    );
  }
  if (config.groupBy !== undefined && !Array.isArray(config.groupBy)) {
    throw new ReportConfigError("La agrupación del reporte no es válida.");
  }
  if (config.sort !== undefined && !Array.isArray(config.sort)) {
    throw new ReportConfigError("El orden del reporte no es válido.");
  }
  if ((config.sort?.length ?? 0) > MAX_SORTS) {
    throw new ReportConfigError(`El reporte tiene demasiados criterios de orden (máximo ${MAX_SORTS}).`);
  }

  const rootEntity = entityOrThrow(config.root);
  const plan = new JoinPlan("t0");
  const binds: unknown[] = [];

  const groupBy = config.groupBy ?? [];
  const isSummary = groupBy.length > 0;

  // Grouped expressions are resolved first so columns can be matched against them.
  const groupedExprs = new Map<string, string[]>();
  for (const path of groupBy) {
    const resolved = resolvePath(rootEntity, path, plan, role);
    if (resolved.selfAggregating) {
      throw new ReportConfigError(
        `No se puede agrupar por "${resolved.label}" porque ya es un resumen.`,
      );
    }
    groupedExprs.set(path, resolved.groupKeys ?? [resolved.sql]);
  }

  const selects: string[] = [];
  const columns: BuiltQuery["columns"] = [];

  config.columns.forEach((spec: ColumnSpec, index) => {
    if (!spec || typeof spec !== "object") {
      throw new ReportConfigError("Hay una columna vacía o mal formada en el reporte.");
    }
    if (spec.agg && !AGG_FNS.includes(spec.agg)) {
      throw new ReportConfigError(`Resumen no permitido: ${String(spec.agg)}`);
    }
    if (spec.label !== undefined && typeof spec.label !== "string") {
      throw new ReportConfigError("El nombre de una columna no es válido.");
    }
    if ((spec.label?.length ?? 0) > MAX_LABEL) {
      throw new ReportConfigError(
        `El nombre de una columna es demasiado largo (máximo ${MAX_LABEL} caracteres).`,
      );
    }

    const resolved = resolvePath(rootEntity, spec.path, plan, role, spec.agg);
    let expr = resolved.sql;
    let kind = resolved.kind;
    const isGrouped = groupedExprs.has(spec.path);

    // The type has to be checked whether or not the expression aggregates
    // itself. It used to be skipped for every to-many aggregate, which is how
    // `sum` over `revisiones.description` built `SUM(s."description")` and let
    // Postgres refuse it with a 42883 — and, because saving validates through
    // this same function, how such a report saved cleanly and then failed on
    // every single run, for its author and for anyone it was shared with.
    if (spec.agg && !AGGS_BY_KIND[resolved.kind]?.includes(spec.agg)) {
      // No article before the aggregate name: "suma" and "promedio" differ in
      // gender and "el suma" reads as broken Spanish.
      throw new ReportConfigError(
        `No se puede aplicar ${AGG_LABEL[spec.agg]} a "${resolved.label}" ` +
          `porque es un campo de tipo ${KIND_LABEL[resolved.kind]}.`,
      );
    }

    if (isSummary) {
      if (!isGrouped && !spec.agg) {
        throw new ReportConfigError(
          `Agrupó el reporte, así que la columna "${resolved.label}" necesita un resumen ` +
            `(conteo, promedio…) o hay que quitarla.`,
        );
      }
      // Silently ignoring the aggregate used to return the grouped value under
      // a header that promised a total.
      if (isGrouped && spec.agg) {
        throw new ReportConfigError(
          `"${resolved.label}" está agrupada, así que no puede llevar además un resumen. ` +
            `Quite el resumen o añada la columna por separado.`,
        );
      }
      if (spec.agg && !isGrouped) {
        // Refused rather than computed, and refused *here* rather than at
        // resolution: a foreign-grain total is right once per row and wrong
        // once per group, so the mode decides. The honest group number would
        // have to count once per parent instead of once per row, which the
        // configuration language cannot express today — and a squared count
        // that looks plausible is worse than a sentence saying it cannot be
        // done.
        if (inflatesAcrossRows(resolved, spec.agg)) {
          throw new ReportConfigError(
            `"${resolved.label}" ya es un total de otra entidad, y ${AGG_LABEL[spec.agg]} aquí ` +
              `lo contaría una vez por fila. Muéstrelo sin agrupar, o cambie el nivel de detalle.`,
          );
        }
        expr = applyAggregate(expr, spec.agg, resolved);
        kind = spec.agg === "count" ? "number" : kind;
      }
    } else if (spec.agg) {
      if (!resolved.selfAggregating) {
        throw new ReportConfigError(
          `La columna "${resolved.label}" usa un resumen, pero el reporte no está agrupado.`,
        );
      }
      // The aggregate of a self-aggregating expression is the one already
      // inside its subquery. Asking for a different one outside a summary does
      // nothing at all, and returning the inner number under a header that
      // promises the outer one is the quiet kind of lie.
      if (resolved.innerAgg !== spec.agg) {
        throw new ReportConfigError(
          `"${resolved.label}" ya es un total de otra entidad y no admite ${AGG_LABEL[spec.agg]} ` +
            `encima. Muéstrelo tal cual, o cambie el nivel de detalle.`,
        );
      }
    }

    const key = `c${index}`;
    selects.push(`${expr} AS ${quote(key)}`);
    // An aggregated value no longer means what the raw field meant: the count
    // of criticality values is not itself a criticality.
    //
    // Neither does a grouped one, and that was the wrong cut. A grouped column
    // holds the key of a group, not a record's state, so anything reading it
    // per row counts groups: the strip over a report grouped by state read
    // "2 eventos · 1 resueltos · 1 pendientes" where the truth was 1.376, 938
    // and 438.
    const semantic = spec.agg || isGrouped ? undefined : resolved.semantic;
    columns.push({ key, label: spec.label?.trim() || resolved.label, kind, semantic });
  });

  // Filters are resolved after columns so they reuse the same joins.
  let whereSql = `t0.${quote("deletedAt")} IS NULL`;
  if (!rootEntity.paranoid) whereSql = "TRUE";
  whereSql += requiredParentGuards(rootEntity, "t0");
  if (config.filters) {
    const filterSql = buildFilters(config.filters, rootEntity, plan, role, binds);
    if (filterSql) whereSql = `${whereSql} AND ${filterSql}`;
  }

  const orderParts: string[] = [];
  for (const sort of config.sort ?? []) {
    if (!sort || typeof sort !== "object") {
      throw new ReportConfigError("Hay un criterio de orden vacío o mal formado.");
    }
    if (sort.dir !== "asc" && sort.dir !== "desc") {
      throw new ReportConfigError(`Orden no válido: ${String(sort.dir)}`);
    }
    if (sort.agg && !AGG_FNS.includes(sort.agg)) {
      throw new ReportConfigError(`Resumen no permitido en el orden: ${String(sort.agg)}`);
    }
    const resolved = resolvePath(rootEntity, sort.path, plan, role, sort.agg);
    // The same type check the columns get. Ordering never had one, so
    // `ORDER BY SUM(t0."description")` reached Postgres and came back a 500 —
    // and the identical mistake in a column is refused with a sentence that
    // explains it.
    if (sort.agg && !AGGS_BY_KIND[resolved.kind]?.includes(sort.agg)) {
      throw new ReportConfigError(
        `No se puede ordenar por ${AGG_LABEL[sort.agg]} de "${resolved.label}" ` +
          `porque es un campo de tipo ${KIND_LABEL[resolved.kind]}.`,
      );
    }
    let expr = resolved.sql;
    if (isSummary && !groupedExprs.has(sort.path)) {
      if (!sort.agg) {
        throw new ReportConfigError(
          `No se puede ordenar por "${resolved.label}" sin agruparlo ni resumirlo.`,
        );
      }
      // The same grain guard the columns get, and for a worse reason: an
      // inflated column is visibly wrong, an inflated ORDER BY is not. Ordering
      // tramos by SUM of a foreign total put only three of the top eight in
      // their real places, with the correct count displayed right beside it.
      if (inflatesAcrossRows(resolved, sort.agg)) {
        throw new ReportConfigError(
          `No se puede ordenar por "${resolved.label}": ya es un total de otra entidad, ` +
            `y ${AGG_LABEL[sort.agg]} aquí lo contaría una vez por fila.`,
        );
      }
      expr = applyAggregate(expr, sort.agg, resolved);
    } else if (sort.agg) {
      // Nothing here will apply it — the expression is grouped, or the report
      // is not a summary — so the ranking would be by a different number from
      // the one asked for, and no header shows the ordering formula. The
      // columns refuse this; the ordering used to accept it and drop the
      // aggregate on the floor.
      throw new ReportConfigError(
        `No se puede ordenar por ${AGG_LABEL[sort.agg]} de "${resolved.label}" ` +
          `en un reporte que no lo resume así.`,
      );
    }
    orderParts.push(`${expr} ${sort.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`);
  }

  /**
   * Deterministic tiebreaker. Without one, Postgres is free to order ties
   * differently on each statement, so paging through a report duplicated some
   * rows and dropped others: 366 of 1376 in a measured run. In detail mode the
   * primary key is unique; in summary mode the group keys are.
   */
  if (isSummary) {
    for (const keys of groupedExprs.values()) {
      for (const expr of keys) orderParts.push(`${expr} ASC`);
    }
  } else {
    orderParts.push(`t0.${quote("id")} ASC`);
  }

  // Coerce then truncate: Number.isFinite("100") is false, so a stringified
  // offset silently became 0 and the user got page 1 while asking for page 2.
  // A fractional value reached Postgres and failed as an invalid bigint.
  const toCount = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  };
  const limit = Math.max(1, Math.min(toCount(config.limit, 500), MAX_ROWS));
  // A ceiling as well as a floor. `1e21` is finite, so it passed the check and
  // bound as the number 1e+21, which Postgres refuses as an invalid bigint —
  // and `handleError` reads an unrecognised database code as a server fault, so
  // a caller mistake came back as a 500 and a line in the error log. No report
  // has a millionth page; past the last one the answer is simply no rows.
  const offset = Math.max(0, Math.min(toCount(config.offset, 0), MAX_ROWS * 1000));

  binds.push(limit);
  const limitBind = `$${binds.length}`;
  binds.push(offset);
  const offsetBind = `$${binds.length}`;

  const sql = [
    `SELECT ${selects.join(", ")}`,
    `FROM ${quote(rootEntity.table)} t0`,
    plan.toSql(),
    `WHERE ${whereSql}`,
    isSummary ? `GROUP BY ${[...groupedExprs.values()].flat().join(", ")}` : "",
    orderParts.length ? `ORDER BY ${orderParts.join(", ")}` : "",
    `LIMIT ${limitBind} OFFSET ${offsetBind}`,
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");

  return { sql, binds, columns };
}

/**
 * Builds the matching COUNT query for pagination.
 * In summary mode it counts groups, not underlying rows.
 */
export function buildCountQuery(config: ReportConfig, role: number): { sql: string; binds: unknown[] } {
  // Same checks as buildQuery, for the same reason: relying on the caller
  // invoking buildQuery first would make this a row-count oracle over non-root
  // entities. The shape check earns its place too — the export path counts
  // before it reads, so this is the first function to touch the body, and a
  // missing configuration used to reach it as a TypeError and leave as a 500.
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ReportConfigError("La configuración del reporte no es válida.");
  }
  if (!catalog.roots.includes(config.root)) {
    throw new ReportConfigError(
      `"${String(config.root)}" no es un nivel de detalle válido para un reporte.`,
    );
  }
  const rootEntity = entityOrThrow(config.root);
  const plan = new JoinPlan("t0");
  const binds: unknown[] = [];

  const groupBy = config.groupBy ?? [];
  const groupedExprs = groupBy.flatMap((path) => {
    const resolved = resolvePath(rootEntity, path, plan, role);
    return resolved.groupKeys ?? [resolved.sql];
  });

  // Same guard as buildQuery, or the two disagree and the total stops matching
  // the rows underneath it.
  let whereSql = rootEntity.paranoid ? `t0.${quote("deletedAt")} IS NULL` : "TRUE";
  whereSql += requiredParentGuards(rootEntity, "t0");
  if (config.filters) {
    const filterSql = buildFilters(config.filters, rootEntity, plan, role, binds);
    if (filterSql) whereSql = `${whereSql} AND ${filterSql}`;
  }

  const inner = [
    `SELECT 1`,
    `FROM ${quote(rootEntity.table)} t0`,
    plan.toSql(),
    `WHERE ${whereSql}`,
    groupedExprs.length ? `GROUP BY ${groupedExprs.join(", ")}` : "",
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");

  return { sql: `SELECT COUNT(*)::int AS total FROM (${inner}) sub`, binds };
}
