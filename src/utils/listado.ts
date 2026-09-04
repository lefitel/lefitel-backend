import type { Response } from "express";
import type { FindOptions } from "sequelize";
import { desplazamiento, Limite, Paginacion, TODAS } from "./paginacion.js";

// One envelope for every listing, and one place that builds it.
//
// §3.3 of the API standard: a listing is a `GET` whose response is a collection
// of rows of a table, and every one of them answers
//
//     { data: [], total: 0, page: 1, limit: 50 }
//
// **Without `totalPages`.** It was in an earlier draft and the audit went
// looking for its readers in the client: two type declarations and **zero**.
// The table derives the page count from `total` and `limit`; a field nobody
// reads is a field somebody eventually computes wrong with nothing to notice.
//
// Before this, seventeen listings answered in three different shapes — fourteen
// a bare array, two an envelope, one an envelope missing half its fields — and
// a reader of the client could not tell which without opening the controller.
// That is the diagnosis §1 of the standard opens with.

/**
 * The most rows one response may carry, and the reason it exists.
 *
 * It governs `limit=all` and nothing else: a page is already capped at 100 by
 * the reader. Worth being honest about what it does **not** do — the unbounded
 * reads in this API are the home screen, the three row-shaped reports and the
 * two Archivos diagnostics, and every one of them is an aggregate response that
 * this rule does not reach. Bounding those is its own task in §9.
 *
 * Five thousand against measured tables: 1.687 poles, 1.514 incidents, 3.406
 * audit-log rows four weeks ago — and the audit log is the only table here that
 * nothing prunes, so it is the one that will meet this first.
 */
export const MAX_LIST_ROWS = 5000;

/** The envelope, and the only shape a listing may answer with. */
export interface Sobre<T> {
  data: T[];
  total: number;
  page: number;
  limit: Limite;
}

/**
 * What `findAndCountAll` needs of a model, and no more.
 *
 * Structural rather than `ModelDefined<A, B>`: each model is generic over its
 * own attributes, so no single instantiation accepts all eighteen.
 */
export interface Contable<T> {
  findAndCountAll(opciones: FindOptions): Promise<{ count: number; rows: T[] }>;
}

/** A collection too large to answer in one response. */
export interface Excede {
  excede: number;
}

export const excedeElTecho = <T>(r: Sobre<T> | Excede): r is Excede =>
  (r as Excede).excede !== undefined;

/**
 * One page of a collection, or all of it, or the news that it is too big.
 *
 * **`limit=all` is fetched with `MAX_LIST_ROWS + 1` and not without a limit at
 * all**, which is the difference between a bounded request and an outage. The
 * count comes back true regardless — a `COUNT` ignores `LIMIT` — so the ceiling
 * is decided on the real total while the rows actually read never exceed 5.001.
 * Counting first in a separate query would be one round trip more for the same
 * guarantee, and would have to reproduce by hand which of the includes change
 * the row count.
 *
 * `distinct` is passed through rather than assumed: the incident list needs it
 * because it joins a `hasMany`, and turning it on everywhere makes Postgres
 * count distinct primary keys on queries that never needed it.
 */
export async function listar<T>(
  modelo: Contable<T>,
  opciones: FindOptions,
  paginacion: Paginacion,
  distinct = false,
): Promise<Sobre<T> | Excede> {
  const todas = paginacion.limit === TODAS;
  const { count, rows } = await modelo.findAndCountAll({
    ...opciones,
    limit: todas ? MAX_LIST_ROWS + 1 : (paginacion.limit as number),
    offset: desplazamiento(paginacion),
    ...(distinct ? { distinct: true } : {}),
  });

  if (todas && count > MAX_LIST_ROWS) return { excede: count };

  return { data: rows, total: count, page: paginacion.page, limit: paginacion.limit };
}

/**
 * The refusal, which is a `422` and deliberately not a `413`.
 *
 * `413` is *Content Too Large* and describes the **request** body — it is what
 * this server already answers to an oversized upload and to an oversized JSON
 * body. A client receiving `413` from `limit=all` could not tell it apart from
 * "your photograph is too big". And the report generator's `413` does not set a
 * precedent either: there the message asks the user to narrow the query, and
 * `limit=all` cannot be narrowed — it is all or nothing.
 *
 * The body carries `total` and `max` because the caller's only useful next move
 * is to page, and it cannot decide that without knowing how far off it was.
 */
export const responderExcede = (res: Response, total: number): void => {
  res.status(422).json({
    message:
      `La consulta devuelve ${total} filas y el máximo por petición es ${MAX_LIST_ROWS}. ` +
      "Pida la lista por páginas.",
    total,
    max: MAX_LIST_ROWS,
  });
};
