// Translates a validated report configuration into parameterised SQL.
//
// Security model: no user-supplied string ever becomes an SQL identifier.
// Paths are looked up in the catalog and what gets written is what the catalog
// declares. Values always travel as bind parameters. Operators come from a
// closed set. Errors carry user-facing Spanish messages, because they surface
// directly in the report builder UI.

import { catalog, MAX_DEPTH, MAX_ROWS } from "./catalog.js";
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
      return buildToManyAggregate(
        landing.entity, landing.alias, segments[i], rest[0], agg, role, path,
      );
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

  const bind = (v: unknown): string => {
    binds.push(v);
    return `$${binds.length}`;
  };

  /**
   * Exclusive upper bound for a calendar day: everything strictly before the
   * next midnight. Every date column is `timestamp with time zone`, so
   * comparing against a bare date dropped the whole final day of a range.
   */
  const dayAfter = (v: unknown) => `(${bind(v)}::date + interval '1 day')`;
  const isDate = resolved.kind === "date";

  switch (operator) {
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new ReportConfigError(
          `El filtro "entre" sobre "${resolved.label}" necesita dos valores.`,
        );
      }
      if (isDate && isPlainDate(value[1])) {
        return `${expr} >= ${bind(value[0])} AND ${expr} < ${dayAfter(value[1])}`;
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
      return `${expr} ILIKE ${bind(`%${value}%`)}`;
    }
    // Whole-day semantics on timestamp columns: "on this day", "up to and
    // including this day", "strictly after this day".
    case "eq":
      if (isDate && isPlainDate(value)) {
        return `${expr} >= ${bind(value)} AND ${expr} < ${dayAfter(value)}`;
      }
      return `${expr} = ${bind(value)}`;
    case "lte":
      if (isDate && isPlainDate(value)) return `${expr} < ${dayAfter(value)}`;
      return `${expr} <= ${bind(value)}`;
    case "gt":
      if (isDate && isPlainDate(value)) return `${expr} >= ${dayAfter(value)}`;
      return `${expr} > ${bind(value)}`;
    case "neq":
      // NULL <> value is NULL, which silently turns a LEFT JOIN into an INNER
      // JOIN and drops rows the user never asked to exclude.
      return `${expr} IS DISTINCT FROM ${bind(value)}`;
    default: {
      const sqlOp = { gte: ">=", lt: "<" }[operator as "gte" | "lt"];
      return `${expr} ${sqlOp} ${bind(value)}`;
    }
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
  if (conditions.length > MAX_CONDITIONS) {
    throw new ReportConfigError(`El reporte tiene demasiados filtros (máximo ${MAX_CONDITIONS}).`);
  }
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

    if (spec.agg && !resolved.selfAggregating && !AGGS_BY_KIND[resolved.kind]?.includes(spec.agg)) {
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
        expr = applyAggregate(expr, spec.agg, resolved);
        kind = spec.agg === "count" ? "number" : kind;
      }
    } else if (spec.agg && !resolved.selfAggregating) {
      throw new ReportConfigError(
        `La columna "${resolved.label}" usa un resumen, pero el reporte no está agrupado.`,
      );
    }

    const key = `c${index}`;
    selects.push(`${expr} AS ${quote(key)}`);
    // An aggregated value no longer means what the raw field meant: the count
    // of criticality values is not itself a criticality.
    const semantic = spec.agg ? undefined : resolved.semantic;
    columns.push({ key, label: spec.label?.trim() || resolved.label, kind, semantic });
  });

  // Filters are resolved after columns so they reuse the same joins.
  let whereSql = `t0.${quote("deletedAt")} IS NULL`;
  if (!rootEntity.paranoid) whereSql = "TRUE";
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
    let expr = resolved.sql;
    if (isSummary && !groupedExprs.has(sort.path)) {
      if (!sort.agg) {
        throw new ReportConfigError(
          `No se puede ordenar por "${resolved.label}" sin agruparlo ni resumirlo.`,
        );
      }
      expr = applyAggregate(expr, sort.agg, resolved);
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
  const offset = Math.max(0, toCount(config.offset, 0));

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

  let whereSql = rootEntity.paranoid ? `t0.${quote("deletedAt")} IS NULL` : "TRUE";
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
