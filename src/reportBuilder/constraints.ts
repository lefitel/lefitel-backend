// Which operators and aggregates make sense for each field type.
//
// Single source of truth: `catalogView` advertises these to the UI and
// `sqlBuilder` enforces them. When they lived only in the catalog view they
// were advisory, so a client could ask for `sum` over a text column and get a
// raw Postgres error back — and, worse, save that report and have it fail
// forever on every execution.

import type { AggFn, FieldKind, Operator, Period } from "./types.js";

export const OPERATORS_BY_KIND: Record<FieldKind, Operator[]> = {
  string: ["eq", "neq", "like", "in", "isnull", "notnull"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "isnull", "notnull"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "period", "isnull", "notnull"],
  boolean: ["eq", "neq", "isnull", "notnull"],
  image: ["isnull", "notnull"],
};

export const AGGS_BY_KIND: Record<FieldKind, AggFn[]> = {
  string: ["count", "min", "max"],
  number: ["count", "sum", "avg", "min", "max"],
  date: ["count", "min", "max"],
  boolean: ["count"],
  image: ["count"],
};

/** Human-readable names used in validation messages. */
export const KIND_LABEL: Record<FieldKind, string> = {
  string: "texto",
  number: "número",
  date: "fecha",
  boolean: "sí/no",
  image: "imagen",
};

/**
 * The operator names the user reads, and the only set of them.
 *
 * These used to be a second vocabulary: the dropdown said "está entre" and the
 * error about it said "entre", for eight of the eleven operators. Two names for
 * one thing in the one place the product is explaining itself. The forms here
 * are now the ones the picker shows, so an error can quote an operator and the
 * reader can find it.
 */
export const OPERATOR_LABEL: Record<Operator, string> = {
  eq: "es igual a",
  neq: "es distinto de",
  gt: "es mayor que",
  gte: "es mayor o igual que",
  lt: "es menor que",
  lte: "es menor o igual que",
  between: "está entre",
  period: "está en el periodo",
  in: "está en la lista",
  like: "contiene",
  isnull: "está vacío",
  notnull: "tiene valor",
};

/**
 * The named periods, in the order the picker lists them: nearest first.
 *
 * Published with the catalog (`buildCatalogView`) for the same reason the
 * limits are: a second list kept by hand on the client is a list that drifts.
 */
export const PERIODS: Period[] = [
  "hoy",
  "ayer",
  "ultimos_7_dias",
  "ultimos_30_dias",
  "esta_semana",
  "semana_pasada",
  "este_mes",
  "mes_pasado",
];

export const PERIOD_LABEL: Record<Period, string> = {
  hoy: "Hoy",
  ayer: "Ayer",
  ultimos_7_dias: "Últimos 7 días (sin contar hoy)",
  ultimos_30_dias: "Últimos 30 días (sin contar hoy)",
  esta_semana: "Esta semana",
  semana_pasada: "La semana pasada",
  este_mes: "Este mes",
  mes_pasado: "El mes pasado",
};

export const AGG_LABEL: Record<AggFn, string> = {
  count: "conteo",
  sum: "suma",
  avg: "promedio",
  min: "mínimo",
  max: "máximo",
};
