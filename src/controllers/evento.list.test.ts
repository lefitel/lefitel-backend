// What the events list can be asked for, and what it sends back.
//
// The events table is server-side: every filter and every sort is a round trip.
// So "the table has no severity column and priority is not filterable" was never
// a frontend omission — the endpoint did not send `criticality` and did not
// accept either filter. An alert saying "4 urgentes" could send you to a screen
// where the four were unfindable.
//
// Severity does not live on the event. It lives on the observation catalogue,
// reached through the `eventoObs` pivot, and an event's severity is the worst
// (lowest) level among its observations — the same rule `getEventCriticality`
// applies on the frontend. These tests pin the SQL that rule compiles to,
// because it is written once and used by both the filter and the sort, and a
// silent divergence between them would sort one way and filter another.
//
// They also pin the two traps this query has:
//
//   - `state` is nullable, so "pendiente" cannot be `state = false`: rows where
//     nobody ever set it would vanish from a list that shows them.
//   - the band name is interpolated into a SQL string, so anything that is not
//     one of the five known bands must produce no condition at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";
import type { Request, Response } from "express";

const findAndCountAll = vi.fn();
const findAll = vi.fn();

vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (cb: (t: unknown) => unknown) => cb({}) },
}));
vi.mock("../models/evento.model.js", () => ({
  EventoModel: {
    findAndCountAll: (...a: unknown[]) => findAndCountAll(...a),
    findAll: (...a: unknown[]) => findAll(...a),
  },
}));
vi.mock("../models/eventoObs.model.js", () => ({ EventoObsModel: {} }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: {} }));
vi.mock("../models/poste.model.js", () => ({
  PosteModel: {},
  POSTE_PUBLIC_ATTRIBUTES: ["id", "name"],
}));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/revision.model.js", () => ({
  RevisionModel: {},
  REVISION_PUBLIC_ATTRIBUTES: ["id", "date"],
}));
vi.mock("../models/solucion.model.js", () => ({ SolucionModel: {} }));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {},
  USUARIO_AS_AUTHOR: ["id", "name", "lastname"],
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("../utils/fileUtils.js", () => ({ deleteImageFile: vi.fn() }));

const { getEvento } = await import("./evento.controller.js");

function res() {
  const r = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return r as unknown as Response & typeof r;
}

/** Runs the handler with a query string and returns the options Sequelize got. */
async function query(q: Record<string, unknown>) {
  await getEvento({ query: q } as unknown as Request, res());
  return findAndCountAll.mock.calls[0][0] as {
    where: Record<string | symbol, unknown>;
    order: unknown[];
    include: Array<{ model: unknown; include?: Array<{ attributes?: string[] }> }>;
  };
}

/** The SQL text of a Sequelize `literal`, wherever it is nested. */
const sql = (v: unknown): string => (v as { val?: string })?.val ?? "";

/** The extra conditions the criticality band adds, if any. */
const bandConditions = (where: Record<string | symbol, unknown>) =>
  (where[Op.and] as unknown[] | undefined) ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
  findAll.mockResolvedValue([]);
});

describe("getEvento — la gravedad viaja al navegador", () => {
  it("envía criticality con cada observación", async () => {
    // Matched by model identity, not by position: several includes carry a
    // nested `["id", "name"]`, so "the first one with children" happily passes
    // while pointing at Ciudad.
    const { EventoObsModel } = await import("../models/eventoObs.model.js");
    const { ObsModel } = await import("../models/obs.model.js");

    const options = await query({});
    const pivot = options.include.find((i) => i.model === EventoObsModel);
    const obs = pivot?.include?.find((i) => (i as { model?: unknown }).model === ObsModel);

    expect(pivot, "el include de eventoObs").toBeDefined();
    expect(obs, "el include de obs dentro de eventoObs").toBeDefined();
    expect(obs?.attributes).toContain("criticality");
  });
});

describe("getEvento — filtro de gravedad", () => {
  it("traduce cada banda a su rango", async () => {
    for (const [band, expected] of [
      ["criticas", "BETWEEN 1 AND 3"],
      ["altas", "BETWEEN 4 AND 5"],
      ["medias", "BETWEEN 6 AND 7"],
      ["bajas", "BETWEEN 8 AND 9"],
    ] as const) {
      vi.clearAllMocks();
      findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
      const options = await query({ filterColumn: "criticality", filterValue: band });
      const conditions = bandConditions(options.where);
      expect(conditions, band).toHaveLength(1);
      expect(sql(conditions[0]), band).toContain(expected);
    }
  });

  it("«sin clasificar» pregunta por ausencia, no por un rango", async () => {
    const options = await query({ filterColumn: "criticality", filterValue: "sin" });
    expect(sql(bandConditions(options.where)[0])).toMatch(/IS NULL\s*$/);
  });

  it("mide la peor observación del evento, como hace la pantalla", async () => {
    const options = await query({ filterColumn: "criticality", filterValue: "criticas" });
    const text = sql(bandConditions(options.where)[0]);
    expect(text).toContain('MIN(o."criticality")');
    expect(text).toContain('FROM "eventoObs" eo');
    expect(text).toContain('eo."id_evento" = "evento"."id"');
  });

  it("ignora una banda que no existe en vez de construir SQL con ella", async () => {
    for (const value of ["urgentes", "1", "constructor", "toString", "1 AND 3) OR (1=1"]) {
      vi.clearAllMocks();
      findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
      const options = await query({ filterColumn: "criticality", filterValue: value });
      expect(bandConditions(options.where), value).toHaveLength(0);
      // And nothing the caller typed reached the query.
      expect(JSON.stringify(options.where), value).not.toContain(value);
    }
  });
});

describe("getEvento — filtros de prioridad y estado", () => {
  it("filtra por prioritarios", async () => {
    const options = await query({ filterColumn: "priority", filterValue: "true" });
    expect(options.where["priority"]).toBe(true);
  });

  it("«pendiente» incluye las filas cuyo estado nunca se fijó", async () => {
    const options = await query({ filterColumn: "state", filterValue: "pending" });
    // `state = false` would drop the null rows the list actually shows.
    expect(options.where["state"]).not.toBe(false);
    expect(options.where["state"]).toEqual({ [Op.not]: true });
  });

  it("«resuelto» sí es el valor exacto", async () => {
    const options = await query({ filterColumn: "state", filterValue: "solved" });
    expect(options.where["state"]).toBe(true);
  });

  it("combina gravedad, prioridad y estado en una sola consulta", async () => {
    const options = await query({
      filterColumn: ["criticality", "priority", "state"],
      filterValue: ["criticas", "true", "pending"],
    });
    expect(options.where["priority"]).toBe(true);
    expect(options.where["state"]).toEqual({ [Op.not]: true });
    expect(sql(bandConditions(options.where)[0])).toContain("BETWEEN 1 AND 3");
  });
});

describe("getEvento — orden por gravedad", () => {
  it("ordena por la peor observación, con las sin clasificar al final", async () => {
    const options = await query({ sortBy: "criticality", sortOrder: "asc" });
    const [expression, direction] = options.order[0] as [unknown, string];
    expect(sql(expression)).toContain('MIN(o."criticality")');
    expect(direction).toBe("ASC NULLS LAST");
  });

  it("ordena con la misma expresión con la que filtra", async () => {
    const sorted = await query({ sortBy: "criticality", sortOrder: "desc" });
    vi.clearAllMocks();
    findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    const filtered = await query({ filterColumn: "criticality", filterValue: "criticas" });

    const sortSql = sql((sorted.order[0] as [unknown, string])[0]);
    const filterSql = sql(bandConditions(filtered.where)[0]);
    expect(filterSql.startsWith(sortSql)).toBe(true);
  });
});
