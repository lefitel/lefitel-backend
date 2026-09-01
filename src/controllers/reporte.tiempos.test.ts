// What "Tiempos de Resolución" measures, and what it used to measure instead.
//
// An evento is born when somebody inspects a pole and finds a fault, and it dies
// when somebody repairs it. The repair is recorded as a `solucions` row, and
// `resolverEvento` writes that row and flips `state` in the same transaction —
// so the solution's date IS the closing date. A `revicions` row is something
// else entirely: a site visit. An evento can have twenty of them and still be
// open.
//
// The old report measured from `createdAt` (when the evento was typed into the
// system) to the LAST revision (the last time anybody went to look at it), and
// labelled the result "días de resolución". Measured against the live database
// that was wrong for 671 of 938 closed eventos, and the median read 9 days when
// the real figure was 44.
//
// Worse, revisions carry the field date — the day the technician was there —
// while the evento carries the day it reached the system, so the subtraction
// came out NEGATIVE for 326 eventos. A `Math.max(0, …)` turned every one of
// those into "resolved in 0 days". A third of the closed eventos were being
// published as instantaneous, and 76 of them had really taken over a month.
//
// So: measure from `evento.date` (when the fault happened) to the solution's
// date (when it was fixed), and when those two are incoherent — a repair dated
// before the fault, which the historical data does contain — DROP the evento
// and report how many were dropped. Counting it as zero is what hid the problem.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const eventoFindAll = vi.fn();
const solucionFindAll = vi.fn();
const revisionFindAll = vi.fn();

vi.mock("../models/evento.model.js", () => ({
  EventoModel: { findAll: (...a: unknown[]) => eventoFindAll(...a) },
}));
vi.mock("../models/solucion.model.js", () => ({
  SolucionModel: { findAll: (...a: unknown[]) => solucionFindAll(...a) },
  SOLUCION_PUBLIC_ATTRIBUTES: ["id", "date"],
}));
vi.mock("../models/revision.model.js", () => ({
  RevisionModel: { findAll: (...a: unknown[]) => revisionFindAll(...a) },
  REVISION_PUBLIC_ATTRIBUTES: ["id", "date"],
}));
vi.mock("../models/eventoObs.model.js", () => ({ EventoObsModel: {} }));
vi.mock("../models/poste.model.js", () => ({ PosteModel: {}, POSTE_PUBLIC_ATTRIBUTES: ["id"] }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: {} }));
vi.mock("../models/adssPoste.model.js", () => ({ AdssPosteModel: {} }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: {} }));
vi.mock("../models/tipoObs.model.js", () => ({ TipoObsModel: {} }));

const { putTiemposResumen } = await import("./reporte.controller.js");

/** One evento as Sequelize hands it over, with the two cities of its tramo. */
function evento(opts: {
  id: number;
  date: string;
  createdAt?: string;
  solucionDate?: string | null;
  revisionDates?: string[];
}) {
  const row = {
    id: opts.id,
    date: new Date(opts.date),
    createdAt: new Date(opts.createdAt ?? opts.date),
    solucions: opts.solucionDate === null || opts.solucionDate === undefined
      ? []
      : [{ date: new Date(opts.solucionDate) }],
    revisions: (opts.revisionDates ?? []).map((d) => ({ date: new Date(d) })),
    poste: {
      id: 1,
      id_ciudadA: 1,
      id_ciudadB: 2,
      ciudadA: { id: 1, name: "Cochabamba" },
      ciudadB: { id: 2, name: "Sacaba" },
    },
  };
  return { toJSON: () => row };
}

function res() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
  };
  return r as unknown as Response & { statusCode: number; body: any };
}

const req = (body: unknown) => ({ body }) as Request;
const RANGO = { fechaInicial: "2026-01-01", fechaFinal: "2026-12-31" };

beforeEach(() => {
  vi.clearAllMocks();
  solucionFindAll.mockResolvedValue([{ dataValues: { id_evento: 1 } }]);
  revisionFindAll.mockResolvedValue([{ dataValues: { id_evento: 1 } }]);
});

describe("putTiemposResumen", () => {
  it("cuenta desde la fecha del hecho, no desde el alta en el sistema", async () => {
    // The fault happened on the 1st; nobody typed it in until the 10th; it was
    // repaired on the 11th. That is 10 days of a pole being broken, not 1.
    //
    // The revision is dated the same day as the repair on purpose: it pins the
    // end of the interval so the only thing this test can be measuring is where
    // the interval STARTS. The old code answered 1 — createdAt to that revision.
    eventoFindAll.mockResolvedValue([
      evento({
        id: 1,
        date: "2026-03-01",
        createdAt: "2026-03-10",
        solucionDate: "2026-03-11",
        revisionDates: ["2026-03-11"],
      }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.tramos[0].avgDias).toBe(10);
  });

  it("cuenta hasta la reparación, no hasta la última visita", async () => {
    // Three site visits, the last on the 5th, and the repair on the 20th. The
    // old code answered 4; the pole was broken for 19 days.
    eventoFindAll.mockResolvedValue([
      evento({
        id: 1,
        date: "2026-03-01",
        solucionDate: "2026-03-20",
        revisionDates: ["2026-03-02", "2026-03-03", "2026-03-05"],
      }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.tramos[0].avgDias).toBe(19);
  });

  it("descarta el evento incoherente en vez de contarlo como cero días", async () => {
    // One honest evento of 10 days and one whose repair predates the fault. The
    // old code clamped the second to 0 and published an average of 5 over two
    // eventos. The truth is one usable evento of 10 days, and one discarded.
    // Both carry a revision so the old code processes them instead of skipping
    // them: without it this test would fail for the wrong reason, on the
    // "no revisions" guard rather than on the clamp it is aimed at.
    eventoFindAll.mockResolvedValue([
      evento({ id: 1, date: "2026-03-01", solucionDate: "2026-03-11", revisionDates: ["2026-03-11"] }),
      evento({ id: 2, date: "2026-03-01", solucionDate: "2026-02-20", revisionDates: ["2026-02-20"] }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.tramos[0].avgDias).toBe(10);
    expect(r.body.tramos[0].count).toBe(1);
    expect(r.body.descartados).toBe(1);
  });

  it("un evento sin reparación registrada no entra en el promedio", async () => {
    eventoFindAll.mockResolvedValue([
      evento({ id: 1, date: "2026-03-01", solucionDate: "2026-03-11", revisionDates: ["2026-03-11"] }),
      evento({ id: 2, date: "2026-03-01", solucionDate: null, revisionDates: ["2026-03-05"] }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.tramos[0].count).toBe(1);
    expect(r.body.tramos[0].avgDias).toBe(10);
  });

  it("el período se filtra por la fecha de reparación, no por la de revisión", async () => {
    // The user asks "what did we repair in March". Selecting by revision date
    // answers a different question: "what did we go and look at in March".
    eventoFindAll.mockResolvedValue([
      evento({ id: 1, date: "2026-03-01", solucionDate: "2026-03-11" }),
    ]);

    await putTiemposResumen(req(RANGO), res());

    expect(solucionFindAll).toHaveBeenCalled();
    const where = solucionFindAll.mock.calls[0][0].where;
    expect(where).toHaveProperty("date");
  });

  it("descarta la reparación anterior al hecho aunque caiga el mismo día", async () => {
    // Dates carry a time of day. A repair at 09:00 for a fault reported at
    // 14:00 the same day is incoherent, but the difference rounds to -0 — and
    // `-0 < 0` is false in JavaScript, so a naive guard on the rounded number
    // lets it through as "repaired in 0 days". Compare the instants, not the
    // rounded days.
    eventoFindAll.mockResolvedValue([
      evento({ id: 1, date: "2026-03-01T10:00:00", solucionDate: "2026-03-11T10:00:00" }),
      evento({ id: 2, date: "2026-03-05T14:00:00", solucionDate: "2026-03-05T09:00:00" }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.descartados).toBe(1);
    expect(r.body.tramos[0].count).toBe(1);
    expect(r.body.tramos[0].minDias).toBe(10);
  });

  it("informa cuántas visitas costó de media cada evento del tramo", async () => {
    // The number of site visits is what replaced "days until inspection": that
    // one measured nothing, because the inspection is how the fault is found in
    // the first place. How MANY visits it took is a real cost — a pole that
    // needed eight is a problem even if it closed quickly.
    eventoFindAll.mockResolvedValue([
      evento({
        id: 1,
        date: "2026-03-01",
        solucionDate: "2026-03-11",
        revisionDates: ["2026-03-02", "2026-03-05", "2026-03-11"],
      }),
      evento({ id: 2, date: "2026-03-01", solucionDate: "2026-03-11", revisionDates: ["2026-03-04"] }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.tramos[0].avgVisitas).toBe(2);
  });

  it("no cuenta las visitas de los eventos que descarta", async () => {
    eventoFindAll.mockResolvedValue([
      evento({ id: 1, date: "2026-03-01", solucionDate: "2026-03-11", revisionDates: ["2026-03-02"] }),
      evento({
        id: 2,
        date: "2026-03-01",
        solucionDate: "2026-02-20",
        revisionDates: ["2026-02-01", "2026-02-05", "2026-02-10", "2026-02-15", "2026-02-20"],
      }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.tramos[0].avgVisitas).toBe(1);
  });

  it("informa cero descartados cuando todos los eventos son coherentes", async () => {
    eventoFindAll.mockResolvedValue([
      evento({ id: 1, date: "2026-03-01", solucionDate: "2026-03-11" }),
    ]);

    const r = res();
    await putTiemposResumen(req(RANGO), r);

    expect(r.body.descartados).toBe(0);
  });
});
