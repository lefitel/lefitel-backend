import type { Request } from "express";

// Reading `page` and `limit`, once, instead of four times differently.
//
// Before this file there were four readers for the same two parameters, and no
// two of them agreed:
//
// | Where | default | min | max |
// |---|---|---|---|
// | `poste.controller.ts` | 50 | **15** | 100 |
// | `evento.controller.ts` | 50 | **15** | 100 |
// | `bitacora.controller.ts` (list) | 50 | **none** | 100 |
// | `bitacora.controller.ts` (per user) | 50 | **none** | **200** |
//
// `?limit=5` answered 15 rows on one screen and 5 on another. But the disagreement
// is the least of it — two of them carried live defects:
//
//   - **`?limit=-5` on either bitácora route is a 500.** No `Math.max`, so
//     `Math.min(-5, 100)` is `-5`, Sequelize emits `LIMIT -5` without validating
//     it, Postgres refuses the statement and `makeHandler` turns that into the
//     neutral 500 that §3.5 reserves for faults nobody expected. The per-user
//     route is behind `requireSelfOrPermission`, so **any live session can
//     trigger it on its own log**.
//   - **`?page=1e999` is a 500 on all three paginated routes.** `Number("1e999")`
//     is `Infinity`, which is truthy, so it passes every clamp and reaches
//     Postgres as `OFFSET Infinity`. Its fractional sibling is the same story:
//     `?limit=20.7` reaches the database as `LIMIT 20.7`. The repository had
//     already measured this once — `reportBuilder/sqlBuilder.ts` says "a
//     fractional value reached Postgres and failed as an invalid bigint", and
//     that is why the report generator's own reader truncates.
//
// So this reader has five rules and not the three the standard's §10 promised:
// **default, floor, ceiling, truncation and finiteness.**
//
// **What it deliberately does not unify.** The report generator's two readers
// (`generador.controller.ts`) stay where they are: `GET /api/generador/reportes`
// pages by `offset` and answers `{rows, total, limit, offset}`, which §3.3
// exempts on purpose, and its clamps are pinned by its own tests.

/** A value nobody sent. Both parameters are optional, so this is not an error. */
const AUSENTE = Symbol("ausente");
/** A value that was sent and cannot be read: an array, an empty field, a shape. */
const ILEGIBLE = Symbol("ilegible");

/** Rows per page when nobody says otherwise. */
export const LIMITE_POR_DEFECTO = 50;
/**
 * The most rows one page may carry.
 *
 * 100, which is what three of the four readers already enforced. The fourth
 * allowed 200 and no caller ever asked for it — the client's own constant is 25.
 */
export const LIMITE_MAXIMO = 100;

/**
 * The whole collection, asked for by name.
 *
 * `limit=all` and **not** `limit=0`, which §3.3 rejects for a measured reason:
 * `Number("0") || 50` is 50 because zero is falsy, so against a server without
 * this reader `limit=0` would answer fifty rows in silence — and a browser-built
 * export would come out truncated with no error anywhere. `all` is not a number
 * and cannot be mistaken for one.
 */
export const TODAS = "all";

/** How many rows a request asked for: a page size, or the whole collection. */
export type Limite = number | typeof TODAS;

export interface Paginacion {
  page: number;
  limit: Limite;
}

/**
 * Either the pagination, or the sentence to answer with.
 *
 * A bare `string` rather than an `{ ok: false }` arm, for the reason
 * `reporteFiltro.ts` documents at length: this compiler does not narrow a
 * discriminated union through an early return, and `typeof x === "string"`
 * narrows everywhere and always.
 *
 *     const p = leerPaginacion(req.query);
 *     if (typeof p === "string") return res.status(400).json({ message: p });
 */
export type Lectura<T> = T | string;

/**
 * One query parameter, as one of three things.
 *
 * **A repeated parameter is illegible, not absent**, and that distinction is the
 * whole reason this returns three states. Express hands `?limit=all&limit=all`
 * back as `["all", "all"]`, and `Number(["all","all"])` is `NaN`, which falls
 * through to the default — so reading a repeat as "not sent" would answer fifty
 * rows to somebody who asked twice for all of them, and a browser-built export
 * would be truncated with nothing to show for it. C1 found the same shape in the
 * reports' filter, where it silently widened the report to the whole network.
 *
 * Worse, a single-element array coerces: `Number(["10"])` is `10`, and
 * `["all"] === "all"` is `false`. So the array has to be refused before either
 * comparison, never after.
 */
const escalar = (valor: unknown): string | typeof AUSENTE | typeof ILEGIBLE => {
  if (valor === undefined) return AUSENTE;
  if (typeof valor !== "string") return ILEGIBLE;
  const limpio = valor.trim();
  return limpio === "" ? ILEGIBLE : limpio;
};

/**
 * A whole number this database can accept, or nothing.
 *
 * `Number.isFinite` before anything else: `Infinity` is truthy and survives
 * every clamp written with `Math.min`/`Math.max`, which is exactly how
 * `?page=1e999` became a 500. `Math.trunc` after it, because Postgres rejects a
 * fractional `LIMIT` and Sequelize passes one straight through.
 */
const entero = (texto: string): number | null => {
  const n = Number(texto);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
};

/**
 * `page` and `limit`, read strictly, for every paginated listing.
 *
 * Out-of-range numbers are clamped rather than refused — `page=0` means the
 * first page and `limit=1000` means the largest page, which is what every one of
 * the four readers already did and what callers depend on. What **is** refused
 * is a value that cannot be read at all, because there is no safe number to
 * substitute for it: silently using the default is how a request that asked for
 * everything gets fifty rows.
 */
export const leerPaginacion = (query: Request["query"]): Lectura<Paginacion> => {
  const limiteCrudo = escalar(query["limit"]);
  if (limiteCrudo === ILEGIBLE) {
    return "El parámetro «limit» está repetido o vacío. Envíe un número o «all».";
  }

  let limit: Limite = LIMITE_POR_DEFECTO;
  if (limiteCrudo !== AUSENTE) {
    if (limiteCrudo === TODAS) {
      limit = TODAS;
    } else {
      const n = entero(limiteCrudo);
      if (n === null) {
        return "El parámetro «limit» no es un número. Envíe un número o «all».";
      }
      limit = Math.min(LIMITE_MAXIMO, Math.max(1, n));
    }
  }

  const pageCrudo = escalar(query["page"]);
  if (pageCrudo === ILEGIBLE) {
    return "El parámetro «page» está repetido o vacío. Envíe un número.";
  }

  let page = 1;
  if (pageCrudo !== AUSENTE) {
    const n = entero(pageCrudo);
    if (n === null) return "El parámetro «page» no es un número.";
    page = Math.max(1, n);
  }

  return { page, limit };
};

/** Rows to skip, given a page and a page size. `TODAS` skips nothing. */
export const desplazamiento = (p: Paginacion): number =>
  p.limit === TODAS ? 0 : (p.page - 1) * p.limit;
