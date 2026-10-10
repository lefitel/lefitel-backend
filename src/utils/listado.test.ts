// `listar()` — the one function every paginated listing in the API goes through.
//
// **Why this file exists, measured rather than argued.** An audit removed the
// `limit` and `offset` that this function hands Sequelize, and ran the whole
// server suite: **2.655 tests, all green.** With those two lines gone,
// `GET /api/poste/` answers with all 1.687 poles and `GET /api/bitacora/` with
// the entire log — while the envelope still says `page: 1, limit: 50`, so the
// screen keeps drawing pagination over a list that was never paged. It then
// deleted the ceiling on `?limit=all`, the one thing standing between a request
// and every row of a table: green again.
//
// Both were invisible for the same reason. `listShape.test.ts` asserts the
// **envelope**, which is built from `paginacion` and not from the query, and its
// model spies answer `{count: 0, rows: []}` whether they were handed a limit or
// not. Nobody read the options. This file reads the options.
//
// It is a unit test on purpose: seventeen listings share this funnel, so a
// defect here is seventeen defects, and no HTTP round trip is needed to see it.
// Nothing is mocked but the model, which is a two-field object; nothing reaches
// Postgres, which in this environment is a copy of production.

import { describe, it, expect, vi } from "vitest";
import { listar, excedeElTecho, MAX_LIST_ROWS } from "./listado.js";
import { TODAS } from "./paginacion.js";

/** A model that records what it was asked and answers what the test says. */
const modelo = (count: number) => {
  const findAndCountAll = vi.fn().mockResolvedValue({ count, rows: [] });
  return { modelo: { findAndCountAll } as never, findAndCountAll };
};

/** The options `listar` really handed Sequelize. */
const consulta = (espia: ReturnType<typeof modelo>["findAndCountAll"]) =>
  espia.mock.calls[0][0] as { limit?: unknown; offset?: unknown; where?: unknown; distinct?: unknown };

describe("lo que listar() le pide a la base", () => {
  it("pasa el tamaño de página y el desplazamiento, que es lo que nadie miraba", async () => {
    // 🔴 La aserción que faltaba. Sin `limit` la consulta trae la tabla entera y
    // el sobre sigue diciendo cincuenta; sin `offset`, la página 3 devuelve la 1
    // y la paginación de la pantalla queda pintada sobre nada.
    const { modelo: m, findAndCountAll } = modelo(120);

    await listar(m, { where: { id_poste: "7" } }, { page: 3, limit: 20 });

    expect(consulta(findAndCountAll).limit).toBe(20);
    expect(consulta(findAndCountAll).offset).toBe(40);
    // Y sin pisar lo que le dio el llamante.
    expect(consulta(findAndCountAll).where).toEqual({ id_poste: "7" });
  });

  it("la primera página no se salta nada", async () => {
    const { modelo: m, findAndCountAll } = modelo(3);
    await listar(m, {}, { page: 1, limit: 50 });
    expect(consulta(findAndCountAll).offset).toBe(0);
  });

  it("devuelve el sobre de cuatro claves, con el total del conteo y no de las filas", async () => {
    // `total` sale del `count`, nunca de `rows.length`: es lo que distingue un
    // cortafuegos vivo de uno inerte en el cliente, que compara los dos.
    const { modelo: m } = modelo(1470);

    const sobre = await listar(m, {}, { page: 2, limit: 50 });

    expect(Object.keys(sobre).sort()).toEqual(["data", "limit", "page", "total"]);
    expect(sobre).toMatchObject({ total: 1470, page: 2, limit: 50 });
  });

  it("pasa `distinct` sólo cuando se lo piden", async () => {
    // La lista de incidencias lo necesita porque une un `hasMany`; encenderlo
    // en todas hace contar claves primarias distintas donde no hacía falta.
    const a = modelo(1);
    await listar(a.modelo, {}, { page: 1, limit: 10 });
    expect(consulta(a.findAndCountAll).distinct).toBeUndefined();

    const b = modelo(1);
    await listar(b.modelo, {}, { page: 1, limit: 10 }, true);
    expect(consulta(b.findAndCountAll).distinct).toBe(true);
  });
});

describe("el techo de `?limit=all`", () => {
  it("pide una fila más que el techo, que es como sabe que se pasó", async () => {
    const { modelo: m, findAndCountAll } = modelo(10);

    await listar(m, {}, { page: 1, limit: TODAS });

    expect(consulta(findAndCountAll).limit).toBe(MAX_LIST_ROWS + 1);
    expect(consulta(findAndCountAll).offset).toBe(0);
  });

  it("se niega por encima del techo, y dice cuántas filas eran", async () => {
    // 🔴 El freno que C3 puso a la exportación construida en el navegador. Se
    // podía borrar con toda la suite en verde, porque `excedeElTecho` y
    // `responderExcede` seguían existiendo: parecía implementado.
    const { modelo: m } = modelo(MAX_LIST_ROWS + 1);

    const resultado = await listar(m, {}, { page: 1, limit: TODAS });

    expect(excedeElTecho(resultado)).toBe(true);
    expect(resultado).toEqual({ excede: MAX_LIST_ROWS + 1 });
  });

  it("justo en el techo sí contesta, y con el sobre", async () => {
    // La otra dirección: un freno que se dispara siempre es un freno roto.
    const { modelo: m } = modelo(MAX_LIST_ROWS);

    const resultado = await listar(m, {}, { page: 1, limit: TODAS });

    expect(excedeElTecho(resultado)).toBe(false);
    expect(resultado).toMatchObject({ total: MAX_LIST_ROWS, limit: TODAS });
  });

  it("el techo no se aplica a una página normal, por grande que sea la tabla", async () => {
    const { modelo: m } = modelo(50_000);

    const resultado = await listar(m, {}, { page: 1, limit: 50 });

    expect(excedeElTecho(resultado)).toBe(false);
    expect(resultado).toMatchObject({ total: 50_000 });
  });
});
