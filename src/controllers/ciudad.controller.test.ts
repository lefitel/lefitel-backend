// The city list carries figures about two other modules, and the route's own
// gate cannot protect them: `ciudades.ver` is all it asks for. What decides
// whether a role sees pole counts or incident counts is the handler, so this is
// the only place that can tell "hidden" from "sent anyway and not drawn".

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findAndCountAll = vi.fn();
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: { findAndCountAll } }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));

const permisos = new Set<string>();
vi.mock("../permissions/store.js", () => ({
  can: async (_rol: number, modulo: string, accion: string) => permisos.has(`${modulo}.${accion}`),
}));

const { getCiudad } = await import("./ciudad.controller.js");

const reqOf = (query: Record<string, string> = {}) =>
  ({ query, params: {}, user: { id: 7, id_rol: 3 } }) as unknown as Request;

const resOf = () =>
  ({ status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn() }) as unknown as Response;

/** The aliases of the computed columns the handler asked the database for. */
const pedidas = (): string[] => {
  const opciones = findAndCountAll.mock.calls[0][0] as { attributes: { include: [unknown, string][] } };
  return opciones.attributes.include.map(([, alias]) => alias);
};

const DE_POSTES = ["postes", "vecinas"];
const DE_EVENTOS = ["pendientes", "prioritarios", "ultimoEvento"];

describe("GET /api/ciudad/", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permisos.clear();
    findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
  });

  it("asks for nothing about poles or incidents for a role that can read neither", async () => {
    await getCiudad(reqOf(), resOf());
    expect(pedidas()).toEqual([]);
  });

  it("asks for the pole figures only, with postes.ver alone", async () => {
    permisos.add("postes.ver");
    await getCiudad(reqOf(), resOf());
    expect(pedidas()).toEqual(DE_POSTES);
  });

  it("asks for the incident figures only, with eventos.ver alone", async () => {
    permisos.add("eventos.ver");
    await getCiudad(reqOf(), resOf());
    expect(pedidas()).toEqual(DE_EVENTOS);
  });

  it("asks for both blocks with both permissions", async () => {
    permisos.add("postes.ver").add("eventos.ver");
    await getCiudad(reqOf(), resOf());
    expect(pedidas()).toEqual([...DE_POSTES, ...DE_EVENTOS]);
  });

  it("counts a city's poles through the tramos that touch it, and no longer names the two columns", async () => {
    permisos.add("postes.ver").add("eventos.ver");
    await getCiudad(reqOf(), resOf());
    const opciones = findAndCountAll.mock.calls[0][0] as { attributes: { include: [{ val: string }, string][] } };
    const sql = opciones.attributes.include.map(([l]) => l.val).join(" ");
    expect(sql).not.toMatch(/id_ciudadA|id_ciudadB/);
    expect(sql).toContain('"id_ciudad_min" = "ciudad"."id"');
    // A neighbour is a city reached over a tramo that has a live pole on it.
    expect(sql).toContain('"postes"."deletedAt" IS NULL');
  });

  it("builds `vecinas` over the tramos, and only names live cities", async () => {
    permisos.add("postes.ver");
    await getCiudad(reqOf(), resOf());
    const opciones = findAndCountAll.mock.calls[0][0] as { attributes: { include: [{ val: string }, string][] } };
    const vecinas = opciones.attributes.include.find(([, alias]) => alias === "vecinas")![0].val;
    expect(vecinas).toContain('"tramos" AS "tv"');
    expect(vecinas).toContain('"vecina"."deletedAt" IS NULL');
  });

  it("is not opened by a write permission on the same module", async () => {
    // `editar` without `ver` is a row the Seguridad screen can produce.
    permisos.add("postes.editar").add("eventos.archivar");
    await getCiudad(reqOf(), resOf());
    expect(pedidas()).toEqual([]);
  });

  it("still answers the envelope", async () => {
    const res = resOf();
    await getCiudad(reqOf(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(Object.keys(vi.mocked(res.json).mock.calls[0][0] as object).sort()).toEqual(["data", "limit", "page", "total"]);
  });
});
