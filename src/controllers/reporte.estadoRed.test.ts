// `estado-red` groups poles by tramo. These cover the one row shape the join
// is not supposed to produce: a pole with an `id_tramo` and no `tramo`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const posteFindAll = vi.fn();

vi.mock("../models/evento.model.js", () => ({ EventoModel: {} }));
vi.mock("../models/solucion.model.js", () => ({ SolucionModel: {}, SOLUCION_PUBLIC_ATTRIBUTES: ["id"] }));
vi.mock("../models/revision.model.js", () => ({ RevisionModel: {}, REVISION_PUBLIC_ATTRIBUTES: ["id"] }));
vi.mock("../models/eventoObs.model.js", () => ({ EventoObsModel: {} }));
vi.mock("../models/poste.model.js", () => ({
  PosteModel: { findAll: (...a: unknown[]) => posteFindAll(...a) },
  POSTE_PUBLIC_ATTRIBUTES: ["id"],
}));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: {} }));
vi.mock("../models/adssPoste.model.js", () => ({ AdssPosteModel: {} }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: {} }));
vi.mock("../models/tipoObs.model.js", () => ({ TipoObsModel: {} }));

const { getEstadoRed } = await import("./reporte.controller.js");

/** One pole as Sequelize hands it over; `tramo: false` leaves the key out. */
function poste(id: number, opts: { tramo: boolean }) {
  // The one without a tramo carries a different `id_tramo`, so it would open a
  // group of its own: only then does the controller have to present its tramo.
  const row: Record<string, unknown> = { id, id_tramo: opts.tramo ? 14 : 15, eventos: [{ id: id * 10, state: false }] };
  if (opts.tramo) {
    row.tramo = {
      id: 14, id_ciudad_min: 1, id_ciudad_max: 2, id_departamento: null, departamento: null,
      ciudadMin: { id: 1, name: "Cochabamba", lat: null, lng: null },
      ciudadMax: { id: 2, name: "Sacaba", lat: null, lng: null },
    };
  }
  return { toJSON: () => row };
}

function res() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
  };
  // Same reason as in `reporte.tiempos.test.ts`: a serialised body walked a few
  // levels deep.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r as unknown as Response & { statusCode: number; body: any };
}

beforeEach(() => vi.clearAllMocks());

describe("getEstadoRed", () => {
  it("skips a pole that came without its tramo and still reports the others", async () => {
    posteFindAll.mockResolvedValue([poste(2, { tramo: false }), poste(1, { tramo: true })]);

    const r = res();
    await getEstadoRed({ query: {} } as Request, r);

    expect(r.statusCode).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ totalPostes: 1, totalPendientes: 1 });
    expect(r.body[0].tramo).toMatchObject({ id: 14, nombre: "Cochabamba – Sacaba" });
  });

  it("asks only for the poles of the tramo when one is named, and for all of them when not", async () => {
    posteFindAll.mockResolvedValue([]);

    await getEstadoRed({ query: { tramo: "14" } } as unknown as Request, res());
    expect(posteFindAll.mock.calls[0][0]).toMatchObject({ where: { id_tramo: 14 } });

    await getEstadoRed({ query: {} } as Request, res());
    expect(posteFindAll.mock.calls[1][0]).not.toHaveProperty("where");
  });
});
