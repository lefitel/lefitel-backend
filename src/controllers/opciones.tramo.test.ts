// `GET /api/tramo/options`: what the tramo screen is given, and the encargado
// picker that only an editor gets.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const ciudad = { findAll: vi.fn() };
const departamento = { findAll: vi.fn() };
const usuario = { findAll: vi.fn() };
const vacio = { findAll: vi.fn(async () => []) };

vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: ciudad }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: departamento }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: usuario, USUARIO_AS_AUTHOR: ["id", "name", "lastname"] }));
vi.mock("../models/adss.model.js", () => ({ AdssModel: vacio }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: vacio }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: vacio }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: vacio }));
vi.mock("../models/tipoObs.model.js", () => ({ TipoObsModel: vacio }));
vi.mock("../models/tramo.model.js", () => ({ TramoModel: vacio, TRAMO_PUBLIC_ATTRIBUTES: [] }));
vi.mock("../utils/logger.js", () => ({
  log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false }),
}));

const permisos = new Set<string>();
vi.mock("../permissions/store.js", () => ({
  can: async (_rol: number, modulo: string, accion: string) => permisos.has(`${modulo}.${accion}`),
}));

const { getOpcionesTramo } = await import("./opciones.controller.js");

const reqOf = () => ({ user: { id: 7, id_rol: 3 } }) as unknown as Request;
const resOf = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }) as unknown as Response;
const cuerpo = (res: Response) => vi.mocked(res.json).mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  permisos.clear();
  ciudad.findAll.mockResolvedValue([{ id: 1, name: "Sucre" }]);
  departamento.findAll.mockResolvedValue([{ id: 5, name: "Potosí" }]);
  usuario.findAll.mockResolvedValue([
    { id: 9, name: "Bea", lastname: "Rojas" },
    { id: 4, name: "Ana", lastname: "Quispe" },
  ]);
});

describe("GET /api/tramo/options", () => {
  it("gives an editor the live accounts by name, sorted, and nothing else of them", async () => {
    permisos.add("tramos.editar");
    const res = resOf();
    await getOpcionesTramo(reqOf(), res);

    expect(usuario.findAll).toHaveBeenCalledWith({ attributes: ["id", "name", "lastname"], raw: true });
    expect(cuerpo(res).usuarios).toEqual([{ id: 4, nombre: "Ana Quispe" }, { id: 9, nombre: "Bea Rojas" }]);
  });

  it("leaves the accounts out, unasked, for somebody who can only see tramos", async () => {
    const res = resOf();
    await getOpcionesTramo(reqOf(), res);

    expect(usuario.findAll).not.toHaveBeenCalled();
    expect(Object.keys(cuerpo(res))).toEqual(["ciudad", "departamento"]);
  });
});
