// The one reader for `page` and `limit`, and the two live defects it closes.
//
// There were four readers before this, none of them agreeing, and two of them
// answering a **500** to a request a stranger can send. Those two are the first
// tests below, and they are not hypothetical: `?limit=-5` on
// `GET /api/usuario/:id/bitacora` is reachable by any live session, since that
// route is gated by `requireSelfOrPermission` — anybody may read their own log.
//
// The rest of the file is about the value that must never be silently replaced
// by a default. Fifty rows where all of them were asked for is the failure this
// whole task exists to prevent: it produces a plausible screen and a truncated
// export, with no error anywhere.

import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
  leerPaginacion, desplazamiento, LIMITE_MAXIMO, LIMITE_POR_DEFECTO, TODAS,
} from "./paginacion.js";

/** `req.query` as Express builds it: strings, or arrays when repeated. */
const q = (query: Record<string, unknown>) => query as Request["query"];

/** Reads and fails the test if the answer was a message rather than a value. */
const leer = (query: Record<string, unknown>) => {
  const p = leerPaginacion(q(query));
  if (typeof p === "string") throw new Error(`esperaba una lectura, dio: ${p}`);
  return p;
};

describe("what used to answer 500", () => {
  it("never lets a negative limit reach the database", () => {
    // `Math.min(Number("-5") || 50, 100)` is -5. Sequelize writes `LIMIT -5`
    // without validating it, Postgres refuses the statement, and `makeHandler`
    // turns that into the neutral 500 kept for faults nobody expected. A number
    // out of range is not a fault: it is clamped, like every other.
    expect(leer({ limit: "-5" }).limit).toBe(1);
    expect(leer({ limit: "-99999" }).limit).toBe(1);
  });

  it("never lets an infinite page reach the database", () => {
    // `Number("1e999")` is `Infinity`, which is truthy and therefore survives
    // `Math.max(1, …)` untouched — it reached Postgres as `OFFSET Infinity` on
    // all three paginated routes.
    expect(leerPaginacion(q({ page: "1e999" }))).toMatch(/no es un número/i);
    expect(leerPaginacion(q({ limit: "1e999" }))).toMatch(/no es un número/i);
    expect(leerPaginacion(q({ page: "-1e999" }))).toMatch(/no es un número/i);
  });

  it("never lets a fractional value reach the database", () => {
    // `LIMIT 20.7` is an invalid bigint. The report generator's own reader
    // already truncated for this exact reason; the four list readers did not.
    expect(leer({ limit: "20.7" }).limit).toBe(20);
    expect(leer({ page: "1.9" }).page).toBe(1);
    expect(desplazamiento(leer({ page: "2.9", limit: "10" }))).toBe(10);
  });
});

describe("the value that must not be silently replaced", () => {
  it("refuses a repeated parameter instead of falling back to the default", () => {
    // Express hands `?limit=all&limit=all` back as an array, and
    // `Number(["all","all"])` is `NaN` — straight to the default. Somebody who
    // asked twice for the whole collection would have got fifty rows, and the
    // export built from them would be truncated with nothing to show for it.
    // The same shape C1 found in the reports' filter, where it widened the
    // report to the entire network.
    expect(leerPaginacion(q({ limit: ["all", "all"] }))).toMatch(/repetido/i);
    expect(leerPaginacion(q({ page: ["1", "2"] }))).toMatch(/repetido/i);
  });

  it("refuses a single-element array too, which is the one that coerces", () => {
    // The trap inside the trap: `Number(["10"])` is `10` and `["all"] === "all"`
    // is `false`. So an array has to be refused before either comparison, never
    // after — a reader that tested for `"all"` first would read `["all"]` as a
    // number, get `NaN`, and answer fifty.
    expect(leerPaginacion(q({ limit: ["all"] }))).toMatch(/repetido/i);
    expect(leerPaginacion(q({ limit: ["10"] }))).toMatch(/repetido/i);
  });

  it("refuses text that is not a number and not `all`", () => {
    expect(leerPaginacion(q({ limit: "todos" }))).toMatch(/no es un número/i);
    expect(leerPaginacion(q({ limit: "50; DROP TABLE" }))).toMatch(/no es un número/i);
  });

  it("refuses an empty parameter rather than guessing", () => {
    expect(leerPaginacion(q({ limit: "" }))).toMatch(/vacío/i);
    expect(leerPaginacion(q({ page: "   " }))).toMatch(/vacío/i);
  });
});

describe("the ordinary readings", () => {
  it("defaults to the first page of fifty", () => {
    const p = leer({});
    expect(p.page).toBe(1);
    expect(p.limit).toBe(LIMITE_POR_DEFECTO);
    expect(desplazamiento(p)).toBe(0);
  });

  it("honours a small page size instead of raising it to fifteen", () => {
    // The old floor of 15 in two of the four readers: `?limit=5` answered five
    // rows on the audit log and fifteen on the pole list, for no stated reason.
    expect(leer({ limit: "5" }).limit).toBe(5);
    expect(leer({ limit: "1" }).limit).toBe(1);
  });

  it("clamps an oversized page rather than refusing it", () => {
    // Clamped and not a 400: `limit=1000` means "the biggest page you have", and
    // three of the four readers already answered it that way. Turning that into
    // an error would break callers over a request that has an obvious answer.
    expect(leer({ limit: "1000" }).limit).toBe(LIMITE_MAXIMO);
    expect(leer({ limit: "200" }).limit).toBe(LIMITE_MAXIMO);
    expect(leer({ page: "0" }).page).toBe(1);
  });

  it("reads `all` as the whole collection, and skips nothing", () => {
    const p = leer({ limit: TODAS });
    expect(p.limit).toBe(TODAS);
    // Even with a page: asking for everything and for page three is a
    // contradiction, and the collection wins. Anything else would silently drop
    // the first rows of an export.
    expect(desplazamiento(leer({ limit: TODAS, page: "3" }))).toBe(0);
  });

  it("computes the offset from the page it actually read", () => {
    expect(desplazamiento(leer({ page: "3", limit: "20" }))).toBe(40);
    expect(desplazamiento(leer({ page: "1" }))).toBe(0);
  });
});
