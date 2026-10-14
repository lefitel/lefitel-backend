// The home screen draws poles and incidents on a map and labels them with the
// tramo they stand on. What is pinned here is what the handler asks for and what
// it sends: the tramo of each pole, presented, and never the two cities.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const eventoFindAll = vi.fn();
const posteFindAll = vi.fn();

vi.mock("../models/evento.model.js", () => ({ EventoModel: { findAll: eventoFindAll } }));
vi.mock("../models/poste.model.js", () => ({ PosteModel: { findAll: posteFindAll } }));
vi.mock("../models/tramo.model.js", () => ({
  TramoModel: {},
  TRAMO_PUBLIC_ATTRIBUTES: ["id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt"],
}));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: {} }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: {} }));
vi.mock("../models/revision.model.js", () => ({ RevisionModel: {} }));
vi.mock("../models/solucion.model.js", () => ({ SolucionModel: {} }));
vi.mock("../models/eventoObs.model.js", () => ({ EventoObsModel: {} }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: {} }));

const { getDashboard } = await import("./dashboard.controller.js");
const { INCLUDE_TRAMO } = await import("../tramos/presentacion.js");

const resOf = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }) as unknown as Response;

const tramoCrudo = {
  id: 14, id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, deletedAt: null,
  ciudadMin: { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ciudadMax: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  departamento: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  eventoFindAll.mockResolvedValue([]);
  posteFindAll.mockResolvedValue([
    { toJSON: () => ({ id: 40, name: "P-001", id_tramo: 14, tramo: tramoCrudo }) },
  ]);
});

describe("getDashboard", () => {
  it("sends each pole with its tramo presented, and never the two cities", async () => {
    const res = resOf();
    await getDashboard({} as Request, res);

    const cuerpo = vi.mocked(res.json).mock.calls[0][0] as { postes: { id_tramo: number; tramo: { nombre: string } }[] };
    expect(cuerpo.postes[0].id_tramo).toBe(14);
    expect(cuerpo.postes[0].tramo.nombre).toBe("Potosí – Sucre");
    expect(JSON.stringify(cuerpo)).not.toMatch(/ciudadA|ciudadB|id_ciudad_min|ciudadMin/);
  });

  it("asks for the tramo, archived or not, instead of the two cities", async () => {
    await getDashboard({} as Request, resOf());

    const opciones = posteFindAll.mock.calls[0][0] as { attributes: string[]; include: { as?: string }[] };
    expect(opciones.attributes).toContain("id_tramo");
    expect(opciones.include).toContain(INCLUDE_TRAMO);
    expect(opciones.include.map((i) => i.as)).not.toContain("ciudadA");
    expect(INCLUDE_TRAMO.paranoid).toBe(false);
  });
});
