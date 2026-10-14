// Creating and editing a pole refuse a pair that is not a coordinate, before
// anything is written.
//
// The rule is tested where it lives (`utils/coordenadas.test.ts`). This is the
// wire: with the two calls in the controller removed, that file stays green and
// the table goes on taking a latitude of minus twenty-two thousand million.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const create = vi.fn();
const save = vi.fn();
const set = vi.fn();
const findOne = vi.fn();
// The tramo a pole stands on is read inside the transaction, under a lock; the
// double answers "live" so that these cases reach the coordinates they are about.
const tramoFindOne = vi.fn();

vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: async (work: (t: unknown) => unknown) => work({ LOCK: { SHARE: "SHARE", UPDATE: "UPDATE" } }) },
}));
vi.mock("../models/poste.model.js", () => ({
  PosteModel: { create: (...a: unknown[]) => create(...a), findOne: (...a: unknown[]) => findOne(...a) },
}));
vi.mock("../models/adss.model.js", () => ({ AdssModel: { findAll: async () => [] } }));
vi.mock("../models/adssPoste.model.js", () => ({ AdssPosteModel: { findAll: async () => [], create: vi.fn() } }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: {} }));
vi.mock("../models/tramo.model.js", () => ({
  TramoModel: { findOne: (...a: unknown[]) => tramoFindOne(...a), findByPk: vi.fn() },
  TRAMO_PUBLIC_ATTRIBUTES: ["id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt"],
}));
// Pulled in by `tramo.controller.ts`, which the pole controller imports for one sentence.
vi.mock("../permissions/store.js", () => ({ can: async () => true }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: {} }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: {}, USUARIO_AS_AUTHOR: ["id", "name", "lastname"] }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("../utils/imageRefs.js", () => ({ deleteImageIfUnreferenced: vi.fn() }));

const { createPoste, updatePoste } = await import("./poste.controller.js");

const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 7, id_rol: 1 }; next(); });
app.post("/", createPoste);
app.put("/:id", updatePoste);

const BUENO = { name: "P52", lat: -22.0283, lng: -63.680898, id_tramo: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  tramoFindOne.mockResolvedValue({ id: 1 });
  create.mockResolvedValue({ dataValues: { id: 1, ...BUENO } });
  findOne.mockResolvedValue({ dataValues: { id: 1240, ...BUENO, image: null }, set, save });
});

describe("createPoste", () => {
  it("refuses an impossible latitude and writes nothing", async () => {
    const res = await request(app).post("/").send({ ...BUENO, lat: -22048385017.82594 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/latitud/);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a pole whose pair is a coordinate", async () => {
    // The control: without it the test above passes on a handler that refuses
    // everything.
    const res = await request(app).post("/").send(BUENO);

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("updatePoste", () => {
  it("refuses an impossible longitude and writes nothing", async () => {
    const res = await request(app).put("/1240").send({ lng: -652112270 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/longitud/);
    expect(set).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("lets a pole with a bad pair be corrected", async () => {
    // What the six stored ones need: the request carries the right value, and
    // only the request is judged — not what the row holds today.
    findOne.mockResolvedValue({
      dataValues: { id: 1240, ...BUENO, lat: -22048385017.82594, image: null }, set, save,
    });

    const res = await request(app).put("/1240").send({ lat: -22.048385 });

    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
