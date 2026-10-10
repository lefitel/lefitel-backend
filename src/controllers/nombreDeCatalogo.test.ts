// The name of a catalogue record, in the six catalogues that had no rule for it.
//
// A role saved without a name took the account form down: its picker lists the
// roles and lower-cases each name to search. Roles were closed first, and an
// audit then found the same door open in every sibling — `POST {}` to any of
// them made a row with `name = NULL`, and the audit log recorded it as
// "Creó ciudad undefined". One table over all six, so that a seventh catalogue
// added without the rule is a row somebody has to decide not to write.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const modelos = vi.hoisted(() => {
  const uno = () => ({ create: vi.fn(), findOne: vi.fn() });
  return { ciudad: uno(), material: uno(), propietario: uno(), tipoObs: uno(), obs: uno(), adss: uno() };
});
const logAction = vi.hoisted(() => vi.fn());

vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: modelos.ciudad }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: modelos.material }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: modelos.propietario }));
vi.mock("../models/tipoObs.model.js", () => ({ TipoObsModel: { ...modelos.tipoObs, findByPk: vi.fn().mockResolvedValue(null) } }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: modelos.obs }));
vi.mock("../models/adss.model.js", () => ({ AdssModel: modelos.adss }));
// Only imported by these controllers for their listings and their archive
// guards, none of which run here.
vi.mock("../models/poste.model.js", () => ({ PosteModel: {} }));
vi.mock("../models/evento.model.js", () => ({ EventoModel: {} }));
vi.mock("../models/adssPoste.model.js", () => ({ AdssPosteModel: {} }));
vi.mock("../permissions/store.js", () => ({ can: () => true }));
vi.mock("../utils/imageRefs.js", () => ({ deleteImageIfUnreferenced: vi.fn() }));
vi.mock("../utils/logAction.js", () => ({ logAction }));

const ciudad = await import("./ciudad.controller.js");
const material = await import("./material.controller.js");
const propietario = await import("./propietario.controller.js");
const tipoObs = await import("./tipoObs.controller.js");
const obs = await import("./obs.controller.js");
const adss = await import("./adss.controller.js");

type Manejador = (req: Request, res: Response) => Promise<unknown>;

const CATALOGOS: {
  nombre: string;
  modelo: { create: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
  crear: Manejador;
  editar: Manejador;
  dice: RegExp;
}[] = [
  { nombre: "ciudad", modelo: modelos.ciudad, crear: ciudad.createCiudad as Manejador, editar: ciudad.updateCiudad as Manejador, dice: /^La ciudad necesita un nombre\.$/ },
  { nombre: "material", modelo: modelos.material, crear: material.createMaterial as Manejador, editar: material.updateMaterial as Manejador, dice: /^El material necesita un nombre\.$/ },
  { nombre: "propietario", modelo: modelos.propietario, crear: propietario.createPropietario as Manejador, editar: propietario.updatePropietario as Manejador, dice: /^El propietario necesita un nombre\.$/ },
  { nombre: "tipo de observación", modelo: modelos.tipoObs, crear: tipoObs.createTipoObs as Manejador, editar: tipoObs.updateTipoObs as Manejador, dice: /^El tipo de observación necesita un nombre\.$/ },
  { nombre: "observación", modelo: modelos.obs, crear: obs.createObs as Manejador, editar: obs.updateObs as Manejador, dice: /^La observación necesita un nombre\.$/ },
  { nombre: "ferretería", modelo: modelos.adss, crear: adss.createAdss as Manejador, editar: adss.updateAdss as Manejador, dice: /^La ferretería necesita un nombre\.$/ },
];

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    end() { return this; },
  };
  // A serialised response, read straight off; see the same note in
  // `rol.controller.test.ts`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res as unknown as Response & { statusCode: number; body: any };
}

const req = (body: unknown, params: Record<string, string> = {}) =>
  ({ body, params, query: {}, user: { id: 1 } } as unknown as Request);

/** A row as `findOne` hands it over, with the two things an edit calls on it. */
const fila = (dataValues: Record<string, unknown>) => ({ dataValues, set: vi.fn(), save: vi.fn() });

beforeEach(() => {
  logAction.mockReset();
  for (const { modelo } of CATALOGOS) {
    modelo.create.mockReset();
    modelo.findOne.mockReset();
  }
});

describe.each(CATALOGOS)("the name of a $nombre", ({ modelo, crear, editar, dice }) => {
  for (const [caso, body] of [
    ["missing", { description: "x" }],
    ["null", { name: null }],
    ["empty", { name: "" }],
    ["only spaces", { name: "   " }],
    ["only a zero width space", { name: "​" }],
    ["not text", { name: 7 }],
  ] as const) {
    it(`refuses to create one whose name is ${caso}, writes nothing and logs nothing`, async () => {
      const res = fakeRes();
      await crear(req(body), res);

      expect(res.statusCode).toBe(400);
      // The sentence names the thing, so the person knows which form to go back to.
      expect(res.body.message).toMatch(dice);
      expect(modelo.create).not.toHaveBeenCalled();
      expect(logAction).not.toHaveBeenCalled();
    });
  }

  it("creates one with the name it checked, trimmed, and logs that name", async () => {
    modelo.create.mockResolvedValue({ dataValues: { id: 9 } });
    const res = fakeRes();
    await crear(req({ name: "  Norte  ", description: "d" }), res);

    expect(res.statusCode).toBe(201);
    expect(modelo.create.mock.calls[0][0]).toMatchObject({ name: "Norte", description: "d" });
    // "Creó ciudad undefined" is what the log said about a nameless one.
    const linea = logAction.mock.calls[0][0];
    expect(String(linea.detail)).toMatch(/Norte$/);
    expect(String(linea.detail)).not.toMatch(/undefined| {2}/);
    expect(linea.metadata.after.name).toBe("Norte");
  });

  for (const [caso, name] of [["blank", " "], ["null", null], ["not text", 7]] as const) {
    it(`refuses an edit whose name is ${caso}, before looking for the row`, async () => {
      const res = fakeRes();
      await editar(req({ name }, { id: "4" }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(dice);
      expect(modelo.findOne).not.toHaveBeenCalled();
    });
  }

  it("writes an edited name trimmed", async () => {
    const guardada = fila({ id: 4, name: "Sur", description: "" });
    modelo.findOne.mockResolvedValue(guardada);
    const res = fakeRes();
    await editar(req({ name: " Norte " }, { id: "4" }), res);

    expect(res.statusCode).toBe(200);
    expect(guardada.set.mock.calls[0][0]).toMatchObject({ name: "Norte" });
  });

  it("lets an edit leave the name alone, and does not write one", async () => {
    const guardada = fila({ id: 4, name: "Sur", description: "" });
    modelo.findOne.mockResolvedValue(guardada);
    const res = fakeRes();
    await editar(req({ description: "nueva" }, { id: "4" }), res);

    expect(res.statusCode).toBe(200);
    expect(guardada.set.mock.calls[0][0]).toEqual({ description: "nueva" });
    expect(guardada.save).toHaveBeenCalledTimes(1);
  });
});
