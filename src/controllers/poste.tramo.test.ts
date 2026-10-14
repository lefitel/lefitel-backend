// A pole stands on a tramo, not between two cities.
//
// What is pinned here is the wire between `poste.controller.ts` and the tramo:
// how the list is filtered and ordered by one, what a pole write refuses, what
// the audit log says when a pole moves, and what a response carries. The rules
// of the tramo itself are tested where they live (`tramo.controller.test.ts`,
// `tramos/nombre.test.ts`, `tramos/presentacion.test.ts`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { Op } from "sequelize";

const poste = {
  create: vi.fn(), findOne: vi.fn(), findAndCountAll: vi.fn(), findAll: vi.fn(),
  restore: vi.fn(), destroy: vi.fn(), count: vi.fn(),
};
const tramo = { findOne: vi.fn(), findByPk: vi.fn(), restore: vi.fn() };
const logAction = vi.fn();

// One transaction object for the whole file, so a test can say that a read or
// a write went through THE transaction and not merely through some transaction.
const T = { LOCK: { SHARE: "SHARE", UPDATE: "UPDATE" } };
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: async (work: (t: unknown) => unknown) => work(T) },
}));
vi.mock("../models/poste.model.js", () => ({ PosteModel: poste }));
vi.mock("../models/tramo.model.js", () => ({
  TramoModel: tramo,
  TRAMO_PUBLIC_ATTRIBUTES: ["id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt"],
}));
vi.mock("../models/adss.model.js", () => ({ AdssModel: { findAll: async () => [] } }));
vi.mock("../models/adssPoste.model.js", () => ({ AdssPosteModel: { findAll: async () => [], create: vi.fn() } }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: {} }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: {} }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: {}, USUARIO_AS_AUTHOR: ["id", "name", "lastname"] }));
// Pulled in by `tramo.controller.ts`, which this controller imports for one sentence.
vi.mock("../permissions/store.js", () => ({ can: async () => true }));
vi.mock("../utils/logAction.js", () => ({ logAction }));
vi.mock("../utils/imageRefs.js", () => ({ deleteImageIfUnreferenced: vi.fn() }));

const {
  filtroDePostes, getPoste, searchPoste, createPoste, updatePoste, desarchivarPoste,
} = await import("./poste.controller.js");
type FiltroPostes = import("./poste.controller.js").FiltroPostes;
const { TRAMO_NO_DISPONIBLE } = await import("./tramo.controller.js");
const { INCLUDE_TRAMO } = await import("../tramos/presentacion.js");

const reqOf = (partes: Partial<Request> = {}) =>
  ({ query: {}, params: {}, body: {}, user: { id: 7, id_rol: 1 }, ...partes }) as unknown as Request;
const resOf = () =>
  ({ status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), headersSent: false }) as unknown as Response;
const cuerpo = (res: Response) => vi.mocked(res.json).mock.calls[0][0] as Record<string, unknown>;

/** A tramo row as `INCLUDE_TRAMO` brings it back: the two ends by id, not by name. */
const tramoCrudo = (extra: Record<string, unknown> = {}) => ({
  id: 14, id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, deletedAt: null,
  ciudadMin: { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ciudadMax: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  departamento: null, ...extra,
});
const OTRO_TRAMO = tramoCrudo({
  id: 20, id_ciudad_min: 7, id_ciudad_max: 9,
  ciudadMin: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  ciudadMax: { id: 9, name: "Oruro", lat: -17.97, lng: -67.11 },
});

/** A model instance, as far as the handlers read one. */
const fila = (datos: Record<string, unknown>) => ({
  dataValues: datos,
  get: (k: string) => datos[k],
  toJSON: () => datos,
  set: vi.fn(),
  save: vi.fn(),
});

const BUENO = { name: "P52", lat: -22.0283, lng: -63.680898, id_tramo: 14 };

/** The log lines written, by action. */
const lineas = (accion: string) =>
  logAction.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((l) => l.action === accion);

beforeEach(() => {
  vi.clearAllMocks();
  poste.create.mockResolvedValue({ dataValues: { id: 1, ...BUENO } });
  tramo.findOne.mockResolvedValue(fila({ id: 14 }));
  tramo.findByPk.mockImplementation(async (pk: number) =>
    pk === 14 ? fila(tramoCrudo()) : pk === 20 ? fila(OTRO_TRAMO) : null);
});

describe("filtroDePostes", () => {
  it("filters by a tramo as one id, and counts from the first pole", () => {
    const f = filtroDePostes({ tramo: "14" }) as FiltroPostes;
    expect(f.where).toEqual({ id_tramo: 14 });
    expect(f.order).toEqual([["id", "ASC"]]);
    expect(f.descripcion).toEqual(["un tramo"]);
  });

  it("filters by a city through the tramos that touch it", () => {
    const f = filtroDePostes({ ciudadId: "3" }) as FiltroPostes;
    // The operator is a symbol, which `JSON.stringify` skips: read it by hand.
    const dentro = (f.where.id_tramo as Record<symbol, { val: string }>)[Op.in];
    const sql = dentro.val;
    expect(sql).toContain('"id_ciudad_min" = 3 OR "id_ciudad_max" = 3');
    expect(sql).not.toContain("id_ciudadA");
    expect(Object.keys(f.where)).toEqual(["id_tramo"]);
    expect(f.descripcion).toEqual(["una ciudad"]);
  });

  it("refuses a tramo or a city it cannot read, instead of listing everything", () => {
    expect(filtroDePostes({ tramo: "abc" })).toBe("El tramo indicado no es válido.");
    expect(filtroDePostes({ ciudadId: "1; drop" })).toBe("La ciudad indicada no es válida.");
  });

  it("refuses a tramo or a city that is not a positive integer PostgreSQL can hold", () => {
    // 400 digits become `Infinity` once turned into a number and written into a
    // SQL literal; eleven digits overflow `integer`. Both used to answer 500.
    const demasiado = ["9".repeat(400), "99999999999", "2147483648", "0", "000"];
    for (const valor of demasiado) {
      expect(filtroDePostes({ tramo: valor }), `tramo ${valor.slice(0, 12)}`).toBe("El tramo indicado no es válido.");
      expect(filtroDePostes({ ciudadId: valor }), `ciudad ${valor.slice(0, 12)}`).toBe("La ciudad indicada no es válida.");
    }
    // The control: the largest `integer` still passes, so the bound is not "refuse everything".
    expect(typeof filtroDePostes({ tramo: "2147483647" })).toBe("object");
    expect(typeof filtroDePostes({ ciudadId: "2147483647" })).toBe("object");
  });

  it("refuses the two-city filter of the previous client by name", () => {
    expect(filtroDePostes({ ciudadA: "3", ciudadB: "7" })).toMatch(/tramo/);
  });

  it("keeps the first-pole-first order inside a tramo even when the screen asks for id descending", () => {
    const dentro = filtroDePostes({ tramo: "14", sortBy: "id", sortOrder: "desc" }) as FiltroPostes;
    expect(dentro.order).toEqual([["id", "ASC"]]);
    // The control: outside a tramo the same request is honoured.
    const fuera = filtroDePostes({ sortBy: "id", sortOrder: "desc" }) as FiltroPostes;
    expect(fuera.order).toEqual([["id", "DESC"]]);
  });

  it("orders by the name of the tramo, not by one of its cities", () => {
    const f = filtroDePostes({ sortBy: "tramo", sortOrder: "asc" }) as FiltroPostes;
    expect(JSON.stringify(f.order)).toContain("id_ciudad_min");
    expect(JSON.stringify(f.order)).not.toContain("ciudadA");
    expect((f.order[0] as unknown[])[1]).toBe("ASC");
  });

  it("breaks ties between poles of one tramo by id, so a page boundary cannot shuffle them", () => {
    const f = filtroDePostes({ sortBy: "tramo", sortOrder: "desc" }) as FiltroPostes;
    expect(f.order).toHaveLength(2);
    expect(f.order[1]).toEqual(["id", "ASC"]);
    // Only when sorting by tramo: any other order is left as it was asked.
    const otro = filtroDePostes({ sortBy: "name", sortOrder: "asc" }) as FiltroPostes;
    expect(otro.order).toEqual([["name", "ASC"]]);
  });

  it("applies the later keys of a multi-column sort, and puts the id tie-breaker last", () => {
    const f = filtroDePostes({ sortBy: ["tramo", "name"], sortOrder: ["asc", "desc"] }) as FiltroPostes;
    expect(f.order).toHaveLength(3);
    expect((f.order[0] as unknown[])[1]).toBe("ASC");
    expect(f.order[1]).toEqual(["name", "DESC"]);
    expect(f.order[2]).toEqual(["id", "ASC"]);
  });

  it("orders that name under the collation it is built with", () => {
    const f = filtroDePostes({ sortBy: "tramo", sortOrder: "desc" }) as FiltroPostes;
    const [expresion, direccion] = f.order[0] as unknown as [{ val: string }, string];
    expect(expresion.val).toMatch(/\) COLLATE "C"$/);
    // Tied to the root column, so the order survives whatever alias the include gets.
    expect(expresion.val).toContain('"poste"."id_tramo"');
    expect(direccion).toBe("DESC");
  });
});

describe("createPoste", () => {
  it("refuses a pole with no tramo, and one whose tramo is missing or archived, with its own sentence", async () => {
    // No tramo at all: refused before the database is asked anything.
    const { id_tramo: _sinTramo, ...sinTramo } = BUENO;
    const primero = resOf();
    await createPoste(reqOf({ body: sinTramo }), primero);
    expect(primero.status).toHaveBeenCalledWith(400);
    expect(cuerpo(primero)).toEqual({ message: TRAMO_NO_DISPONIBLE });
    expect(tramo.findOne).not.toHaveBeenCalled();
    expect(poste.create).not.toHaveBeenCalled();

    // Missing and archived look the same from here: the live read finds no row.
    tramo.findOne.mockResolvedValue(null);
    const segundo = resOf();
    await createPoste(reqOf({ body: BUENO }), segundo);
    expect(segundo.status).toHaveBeenCalledWith(400);
    expect(cuerpo(segundo)).toEqual({ message: TRAMO_NO_DISPONIBLE });
    expect(tramo.findOne).toHaveBeenCalledTimes(1);
    expect(poste.create).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
    expect(TRAMO_NO_DISPONIBLE).toBe("El tramo indicado no existe o está archivado.");
  });

  it("refuses a tramo id PostgreSQL cannot hold as a 400, before asking the database", async () => {
    for (const id_tramo of [2147483648, "2147483648", 99999999999, 1e21]) {
      const res = resOf();
      await createPoste(reqOf({ body: { ...BUENO, id_tramo } }), res);
      expect(res.status, String(id_tramo)).toHaveBeenCalledWith(400);
      expect(cuerpo(res)).toEqual({ message: TRAMO_NO_DISPONIBLE });
    }
    expect(tramo.findOne).not.toHaveBeenCalled();
    expect(poste.create).not.toHaveBeenCalled();
    // The control: the largest `integer` still gets as far as the look-up.
    await createPoste(reqOf({ body: { ...BUENO, id_tramo: 2147483647 } }), resOf());
    expect(tramo.findOne).toHaveBeenCalledTimes(1);
  });

  it("looks the tramo up inside the transaction with a shared lock", async () => {
    const res = resOf();
    await createPoste(reqOf({ body: BUENO }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(tramo.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: "SHARE", transaction: T }));
    const opciones = tramo.findOne.mock.calls[0][0] as Record<string, unknown>;
    expect(opciones.where).toEqual({ id: 14 });
    // Live rows only: asking for the archived ones too would let the pole in.
    expect(opciones.paranoid).not.toBe(false);
    // And the pole is written after the look, in that same transaction.
    expect(poste.create).toHaveBeenCalledTimes(1);
    expect(poste.create.mock.calls[0][1]).toEqual(expect.objectContaining({ transaction: T }));
    expect(tramo.findOne.mock.invocationCallOrder[0]).toBeLessThan(poste.create.mock.invocationCallOrder[0]);
  });
});

describe("updatePoste", () => {
  const enElTramo14 = () => fila({ id: 8, name: "P-8", image: null, id_tramo: 14 });

  it("records a move to another tramo by the two names", async () => {
    const p = enElTramo14();
    poste.findOne.mockResolvedValue(p);
    tramo.findOne.mockResolvedValue(fila({ id: 20 }));
    const res = resOf();
    await updatePoste(reqOf({ params: { id: "8" }, body: { id_tramo: 20 } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(p.save).toHaveBeenCalledTimes(1);
    const [linea] = lineas("UPDATE_POSTE");
    const meta = linea.metadata as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(meta.before.id_tramo).toEqual({ id: 14, name: "Potosí – Sucre" });
    expect(meta.after.id_tramo).toEqual({ id: 20, name: "Oruro – Potosí" });
  });

  it("does not ask the tramo for a `name` column it does not have", async () => {
    poste.findOne.mockResolvedValue(enElTramo14());
    tramo.findOne.mockResolvedValue(fila({ id: 20 }));
    await updatePoste(reqOf({ params: { id: "8" }, body: { id_tramo: 20 } }), resOf());

    // Both names were looked up, the old and the new.
    expect(tramo.findByPk.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([14, 20]));
    for (const [, opciones] of tramo.findByPk.mock.calls as [number, { attributes: unknown; include: unknown }][]) {
      expect(opciones.attributes).toEqual(INCLUDE_TRAMO.attributes);
      expect(opciones.attributes).not.toEqual(["id", "name"]);
      expect(opciones.attributes).not.toContain("name");
      // The name comes from the two cities, so they have to be asked for.
      expect(opciones.include).toEqual(INCLUDE_TRAMO.include);
    }
    for (const [opciones] of tramo.findOne.mock.calls as [{ attributes?: unknown }][]) {
      expect(opciones.attributes).not.toContain("name");
    }
  });

  it("refuses a move to a tramo that is archived", async () => {
    const p = enElTramo14();
    poste.findOne.mockResolvedValue(p);
    // The live read of the destination finds nothing.
    tramo.findOne.mockResolvedValue(null);
    const res = resOf();
    await updatePoste(reqOf({ params: { id: "8" }, body: { id_tramo: 20 } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cuerpo(res)).toEqual({ message: TRAMO_NO_DISPONIBLE });
    expect(p.save).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("checks the destination under a shared lock, in the transaction that saves", async () => {
    const p = enElTramo14();
    poste.findOne.mockResolvedValue(p);
    tramo.findOne.mockResolvedValue(fila({ id: 20 }));
    await updatePoste(reqOf({ params: { id: "8" }, body: { id_tramo: 20 } }), resOf());

    expect(tramo.findOne).toHaveBeenCalledTimes(1);
    const opciones = tramo.findOne.mock.calls[0][0] as Record<string, unknown>;
    expect(opciones).toEqual(expect.objectContaining({ where: { id: 20 }, lock: "SHARE", transaction: T }));
    expect(opciones.paranoid).not.toBe(false);
    expect(p.save).toHaveBeenCalledWith({ transaction: T });
    expect(tramo.findOne.mock.invocationCallOrder[0]).toBeLessThan(p.save.mock.invocationCallOrder[0]);
  });

  it("refuses a tramo it cannot read as an id, without asking the database", async () => {
    for (const id_tramo of [null, "abc", 0, 2.5]) {
      const p = enElTramo14();
      poste.findOne.mockResolvedValue(p);
      const res = resOf();
      await updatePoste(reqOf({ params: { id: "8" }, body: { id_tramo } }), res);

      expect(res.status, JSON.stringify(id_tramo)).toHaveBeenCalledWith(400);
      expect(cuerpo(res)).toEqual({ message: TRAMO_NO_DISPONIBLE });
      expect(p.save).not.toHaveBeenCalled();
    }
    expect(tramo.findOne).not.toHaveBeenCalled();
  });

  it("neither looks the tramo up nor records it when the pole stays where it is", async () => {
    const p = enElTramo14();
    poste.findOne.mockResolvedValue(p);
    const res = resOf();
    await updatePoste(reqOf({ params: { id: "8" }, body: { name: "P-9", id_tramo: "14" } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(tramo.findOne).not.toHaveBeenCalled();
    expect(tramo.findByPk).not.toHaveBeenCalled();
    const [linea] = lineas("UPDATE_POSTE");
    const meta = linea.metadata as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(meta.before).toEqual({ name: "P-8" });
    expect(meta.after).toEqual({ name: "P-9" });
  });
});

describe("desarchivarPoste", () => {
  const archivado = () => fila({ id: 8, id_tramo: 14, deletedAt: new Date() });

  it("brings the pole's tramo back with it when that was archived too", async () => {
    poste.findOne.mockResolvedValue(archivado());
    tramo.findOne.mockResolvedValue(fila({ id: 14, deletedAt: new Date() }));
    const res = resOf();
    await desarchivarPoste(reqOf({ params: { id: "8" } }), res);

    expect(res.status).toHaveBeenCalledWith(204);
    // One unit with the pole: the same transaction on both restores.
    expect(tramo.restore).toHaveBeenCalledTimes(1);
    expect(tramo.restore).toHaveBeenCalledWith({ where: { id: 14 }, transaction: T });
    expect(poste.restore).toHaveBeenCalledWith({ where: { id: "8" }, transaction: T });
    // The tramo was read among the archived, under a lock, in that transaction.
    expect(tramo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 14 }, paranoid: false, lock: "UPDATE", transaction: T }),
    );
    expect(lineas("RESTORE_TRAMO")).toEqual([expect.objectContaining({ entity: "Tramo", entity_id: 14 })]);
    expect(lineas("RESTORE_POSTE")).toEqual([expect.objectContaining({ entity: "Poste", entity_id: 8 })]);
  });

  it("leaves a live tramo alone", async () => {
    poste.findOne.mockResolvedValue(archivado());
    tramo.findOne.mockResolvedValue(fila({ id: 14, deletedAt: null }));
    const res = resOf();
    await desarchivarPoste(reqOf({ params: { id: "8" } }), res);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(tramo.restore).not.toHaveBeenCalled();
    expect(lineas("RESTORE_TRAMO")).toEqual([]);
    // The control: the pole itself did come back.
    expect(poste.restore).toHaveBeenCalledWith({ where: { id: "8" }, transaction: T });
    expect(lineas("RESTORE_POSTE")).toHaveLength(1);
  });

  it("answers 404 and touches nothing when the pole was not archived, or is not there", async () => {
    for (const encontrado of [fila({ id: 8, id_tramo: 14, deletedAt: null }), null]) {
      poste.findOne.mockResolvedValue(encontrado);
      const res = resOf();
      await desarchivarPoste(reqOf({ params: { id: "8" } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    }
    expect(poste.restore).not.toHaveBeenCalled();
    expect(tramo.findOne).not.toHaveBeenCalled();
    expect(tramo.restore).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("what the list and the detail send", () => {
  const PROHIBIDAS = ["ciudadA", "ciudadB", "id_ciudad_min", "id_ciudad_max", "ciudadMin", "ciudadMax"];
  const unPoste = () => fila({ id: 40, name: "P-001", lat: -19.3, lng: -65.5, id_tramo: 14, tramo: tramoCrudo() });
  /** The includes of a query, as the aliases and models they name. */
  const incluye = (opciones: unknown) => (opciones as { include: { model: unknown; as?: string }[] }).include;

  const comprobar = (p: Record<string, unknown>, envio: unknown) => {
    expect(p.id_tramo).toBe(14);
    const t = p.tramo as { id: number; nombre: string; ciudades: { id: number; name: string }[]; archivado: boolean };
    expect(t.nombre).toBe("Potosí – Sucre");
    // In the order the name reads them, each with its point.
    expect(t.ciudades).toEqual([
      { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
      { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
    ]);
    expect(t.archivado).toBe(false);
    const texto = JSON.stringify(envio);
    for (const clave of PROHIBIDAS) expect(texto, clave).not.toContain(clave);
  };

  it("sends each pole with its tramo presented and no city columns", async () => {
    poste.findAndCountAll.mockResolvedValue({ count: 1, rows: [unPoste()] });
    const lista = resOf();
    await getPoste(reqOf(), lista);

    expect(lista.status).toHaveBeenCalledWith(200);
    const sobre = cuerpo(lista);
    expect(Object.keys(sobre).sort()).toEqual(["data", "limit", "page", "total"]);
    comprobar((sobre.data as Record<string, unknown>[])[0], sobre);
    const deLaLista = incluye(poste.findAndCountAll.mock.calls[0][0]);
    expect(deLaLista).toContain(INCLUDE_TRAMO);
    expect(deLaLista.map((i) => i.as)).not.toEqual(expect.arrayContaining(["ciudadA"]));
    expect(deLaLista.map((i) => i.as)).not.toEqual(expect.arrayContaining(["ciudadB"]));

    poste.findOne.mockResolvedValue(unPoste());
    const detalle = resOf();
    await searchPoste(reqOf({ params: { id: "40" } }), detalle);

    expect(detalle.status).toHaveBeenCalledWith(200);
    comprobar(cuerpo(detalle), cuerpo(detalle));
    const delDetalle = incluye(poste.findOne.mock.calls[0][0]);
    expect(delDetalle).toContain(INCLUDE_TRAMO);
    expect(delDetalle.map((i) => i.as)).not.toEqual(expect.arrayContaining(["ciudadA"]));
    expect(delDetalle.map((i) => i.as)).not.toEqual(expect.arrayContaining(["ciudadB"]));
  });

  it("sends an archived tramo as a tramo, never as null", async () => {
    poste.findOne.mockResolvedValue(
      fila({ id: 40, name: "P-001", id_tramo: 14, tramo: tramoCrudo({ deletedAt: "2026-10-01T00:00:00.000Z" }) }),
    );
    const res = resOf();
    await searchPoste(reqOf({ params: { id: "40" } }), res);

    const t = cuerpo(res).tramo as { nombre: string; archivado: boolean };
    expect(t.nombre).toBe("Potosí – Sucre");
    expect(t.archivado).toBe(true);
  });
});
