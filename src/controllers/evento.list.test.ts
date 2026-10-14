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
const findOne = vi.fn();

vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (cb: (t: unknown) => unknown) => cb({}) },
}));
vi.mock("../models/evento.model.js", () => ({
  EventoModel: {
    findAndCountAll: (...a: unknown[]) => findAndCountAll(...a),
    findAll: (...a: unknown[]) => findAll(...a),
    findOne: (...a: unknown[]) => findOne(...a),
  },
}));
vi.mock("../models/eventoObs.model.js", () => ({ EventoObsModel: {} }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: {} }));
vi.mock("../models/poste.model.js", () => ({
  PosteModel: {},
  POSTE_PUBLIC_ATTRIBUTES: ["id", "name"],
}));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: {} }));
vi.mock("../models/tramo.model.js", () => ({
  TramoModel: {},
  TRAMO_PUBLIC_ATTRIBUTES: ["id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt"],
}));
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

const { getEvento, searchEvento } = await import("./evento.controller.js");
const { INCLUDE_TRAMO } = await import("../tramos/presentacion.js");
const { PosteModel } = await import("../models/poste.model.js");

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

  it("rechaza una banda que no existe en vez de construir SQL con ella", async () => {
    // La propiedad que importa sigue siendo la misma — el texto del que llama no
    // llega jamás a la cadena SQL — y ahora se cumple de una forma más fuerte:
    // la consulta ni se ejecuta. Esta prueba decía "ignora" y ese era el
    // comportamiento: la banda desconocida no aplicaba nada y la respuesta era
    // la lista entera, con el filtro pintado como activo en pantalla. Un filtro
    // que calla y no hace nada es peor que uno que dice que no puede, que es lo
    // que el guardián de columnas de este mismo controlador ya sostenía un nivel
    // más arriba.
    for (const value of ["urgentes", "1", "constructor", "toString", "1 AND 3) OR (1=1"]) {
      vi.clearAllMocks();
      findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
      const r = res();
      await getEvento({ query: { filterColumn: "criticality", filterValue: value } } as unknown as Request, r);

      expect(r.status, value).toHaveBeenCalledWith(400);
      // Y — lo que esta prueba existe para medir — no se llegó a consultar nada,
      // así que no hay SQL en el que el texto pudiera haberse interpolado.
      expect(findAndCountAll, value).not.toHaveBeenCalled();
      // El mensaje repite el valor para que el usuario sepa cuál fue; eso es
      // texto de una respuesta JSON, no de una consulta.
      const cuerpo = r.json.mock.calls[0][0] as { message: string };
      expect(cuerpo.message, value).toContain(value);
    }
  });

  it("acepta las cinco bandas, para que la de arriba no pase rechazándolo todo", async () => {
    for (const value of ["criticas", "altas", "medias", "bajas", "sin"]) {
      vi.clearAllMocks();
      findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
      const options = await query({ filterColumn: "criticality", filterValue: value });
      expect(bandConditions(options.where), value).toHaveLength(1);
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

// The tramo's card lists the incidents still open on that tramo. The tramo
// list already counts them (`pendientes`), and this has to list the same rows.
describe("getEvento — los eventos de un tramo", () => {
  const poste = (options: Awaited<ReturnType<typeof query>>) =>
    options.include.find((i) => i.model === PosteModel) as { where?: Record<string, unknown>; required?: boolean };

  it("narrows to the incidents on that tramo's poles, through the pole and not the incident", async () => {
    const options = await query({ tramo: "14" });

    // An incident has no tramo of its own: the condition belongs in the pole.
    expect(options.where).not.toHaveProperty("id_tramo");
    expect(poste(options).where).toMatchObject({ id_tramo: 14 });
    // And it must narrow, not merely decorate: a left join would answer every incident.
    expect(poste(options).required).toBe(true);
  });

  it("leaves out the incidents of an archived pole, as the count on the tramo's row does", async () => {
    // The pole include is `paranoid: false`, so that an archived pole still
    // names itself on its incident. For this question that would list rows
    // the count beside it never counted.
    const options = await query({ tramo: "14" });

    expect(poste(options).where).toMatchObject({ deletedAt: null });
  });

  it("combines with the pending filter, which is what the card asks for", async () => {
    const options = await query({ tramo: "14", filterColumn: "state", filterValue: "pending" });

    expect(options.where["state"]).toEqual({ [Op.not]: true });
    expect(poste(options).where).toMatchObject({ id_tramo: 14, deletedAt: null });
  });

  it("combines with a filter by pole name without either replacing the other", async () => {
    const options = await query({ tramo: "14", filterColumn: "poste", filterValue: "P-0" });

    expect(poste(options).where).toMatchObject({ id_tramo: 14, deletedAt: null });
    expect(poste(options).where).toHaveProperty("name");
  });

  it.each(["abc", "", "0", "-3", "1.5", "99999999999"])(
    "refuses a tramo it cannot read (%j) rather than answering every incident",
    async (tramo) => {
      const r = res();
      await getEvento({ query: { tramo } } as unknown as Request, r);

      expect(r.status).toHaveBeenCalledWith(400);
      expect(findAndCountAll).not.toHaveBeenCalled();
    },
  );

  it("touches nothing of the pole when no tramo is asked for", async () => {
    const options = await query({});

    expect(poste(options).where).toBeUndefined();
    expect(poste(options).required).toBeUndefined();
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

// ── The pole of each incident stands on a tramo ──────────────────────────────

/** A tramo row as `INCLUDE_TRAMO` brings it back: the two ends by id, not by name. */
const tramoCrudo = (extra: Record<string, unknown> = {}) => ({
  id: 14, id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, deletedAt: null,
  ciudadMin: { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ciudadMax: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  departamento: null, ...extra,
});

describe("getEvento — el tramo del poste", () => {
  it("sends the pole of each incident with its tramo, archived or not, and never the two cities", async () => {
    const fila = {
      id: 5, description: "Cable suelto", id_poste: 40,
      poste: { id: 40, name: "P-001", id_tramo: 14, tramo: tramoCrudo({ deletedAt: "2026-10-01T00:00:00.000Z" }) },
    };
    findAndCountAll.mockResolvedValue({ count: 1, rows: [{ toJSON: () => fila }] });
    const r = res();
    await getEvento({ query: {} } as unknown as Request, r);

    const cuerpo = r.json.mock.calls[0][0] as { data: { poste: { id_tramo: number; tramo: { nombre: string; archivado: boolean } } }[] };
    expect(cuerpo.data[0].poste.id_tramo).toBe(14);
    expect(cuerpo.data[0].poste.tramo.archivado).toBe(true);
    expect(cuerpo.data[0].poste.tramo.nombre).toBe("Potosí – Sucre");
    expect(JSON.stringify(cuerpo)).not.toMatch(/ciudadA|ciudadB|id_ciudad_min/);
  });

  it("orders by the name of the tramo through the incident's own column", async () => {
    const options = await query({ sortBy: "tramo", sortOrder: "asc" });
    const [expresion, direccion] = options.order[0] as [{ val: string }, string];
    // The list paginates with a subquery, where the include's alias does not
    // exist; the incident's own column does. Read off `.val`, because
    // `JSON.stringify` would escape the quotes of the identifier.
    expect(expresion.val).toContain('"evento"."id_poste"');
    expect(JSON.stringify(options.order)).not.toContain("ciudadA");
    expect(expresion.val).toMatch(/\) COLLATE "C"$/);
    expect(direccion).toBe("ASC");
    // Many incidents share a tramo: the id keeps them from shuffling between pages.
    expect(options.order[1]).toEqual(["id", "ASC"]);
  });

  it("applies the later keys of a multi-column sort, and puts the id tie-breaker last", async () => {
    const options = await query({ sortBy: ["tramo", "date"], sortOrder: ["asc", "desc"] });
    expect(options.order).toHaveLength(3);
    expect((options.order[0] as [{ val: string }, string])[1]).toBe("ASC");
    expect(options.order[1]).toEqual(["date", "DESC"]);
    expect(options.order[2]).toEqual(["id", "ASC"]);
  });

  it("asks for the tramo of an archived pole too", async () => {
    const options = await query({});
    const poste = options.include.find((i) => i.model === PosteModel) as unknown as
      { attributes: string[]; paranoid: boolean; include: unknown[] };
    expect(poste.paranoid).toBe(false);
    expect(poste.attributes).toContain("id_tramo");
    expect(poste.attributes).not.toContain("id_ciudadA");
    expect(poste.include).toContain(INCLUDE_TRAMO);
    expect(INCLUDE_TRAMO.paranoid).toBe(false);
  });

  it("sends the detail of an incident with its pole's tramo presented, from the same include", async () => {
    findOne.mockResolvedValue({
      toJSON: () => ({ id: 5, poste: { id: 40, id_tramo: 14, tramo: tramoCrudo() } }),
    });
    const r = res();
    await searchEvento({ params: { id: "5" } } as unknown as Request, r);

    const cuerpo = r.json.mock.calls[0][0] as { poste: { tramo: { nombre: string } } };
    expect(cuerpo.poste.tramo.nombre).toBe("Potosí – Sucre");
    expect(JSON.stringify(cuerpo)).not.toMatch(/ciudadA|ciudadB|id_ciudad_min/);
    const poste = (findOne.mock.calls[0][0] as { include: { model: unknown; include: unknown[] }[] })
      .include.find((i) => i.model === PosteModel);
    expect(poste?.include).toContain(INCLUDE_TRAMO);
  });
});
