// The tramo resource. What is pinned here is what the constraints in the
// database cannot say on their own: which answer a person gets.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const tramo = {
  findOne: vi.fn(), findByPk: vi.fn(), findAndCountAll: vi.fn(), create: vi.fn(), restore: vi.fn(), destroy: vi.fn(),
};
const ciudad = { count: vi.fn(), findAll: vi.fn() };
const departamento = { findByPk: vi.fn(), findAll: vi.fn() };
const poste = { count: vi.fn() };
const logAction = vi.fn();
const fallo = vi.fn();

vi.mock("../models/tramo.model.js", () => ({
  TramoModel: tramo,
  TRAMO_PUBLIC_ATTRIBUTES: ["id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt"],
}));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: ciudad }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: departamento }));
vi.mock("../models/poste.model.js", () => ({ PosteModel: poste }));
vi.mock("../utils/logAction.js", () => ({ logAction }));
vi.mock("../utils/logger.js", () => ({
  log: () => ({ error: fallo, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false }),
}));
// One transaction object for the whole file, so a test can say that a write
// went through THE transaction and not merely through some transaction.
const tx = { LOCK: { UPDATE: "UPDATE" } };
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx) },
}));

const permisos = new Set<string>();
vi.mock("../permissions/store.js", () => ({
  can: async (_rol: number, modulo: string, accion: string) => permisos.has(`${modulo}.${accion}`),
}));

const { createTramo, updateTramo, deleteTramo, desarchivarTramo, searchTramo, getTramo, leerCiudades } = await import("./tramo.controller.js");

const fila = (extra: Record<string, unknown> = {}) => {
  const datos: Record<string, unknown> = {
    id: 14, id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, deletedAt: null,
    ciudadMin: { id: 3, name: "Sucre", lat: 0, lng: 0 }, ciudadMax: { id: 7, name: "Potosí", lat: 0, lng: 0 },
    departamento: null, ...extra,
  };
  return {
    dataValues: datos,
    get: (k: string) => datos[k],
    toJSON: () => datos,
    set: vi.fn((cambios: Record<string, unknown>) => Object.assign(datos, cambios)),
    save: vi.fn(), restore: vi.fn(async () => { datos.deletedAt = null; }), destroy: vi.fn(),
  };
};

const reqOf = (partes: Partial<Request> = {}) =>
  ({ query: {}, params: {}, body: {}, user: { id: 7, id_rol: 3 }, ...partes }) as unknown as Request;
const resOf = () =>
  ({ status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), headersSent: false }) as unknown as Response;
const cuerpo = (res: Response) => vi.mocked(res.json).mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  permisos.clear();
  ciudad.count.mockResolvedValue(2);
  departamento.findByPk.mockResolvedValue({ id: 5 });
  poste.count.mockResolvedValue(0);
});

describe("leerCiudades", () => {
  it("hands back the two ids lowest first, whatever order they came in", () => {
    expect(leerCiudades({ ciudades: [7, 3] })).toEqual([3, 7]);
    expect(leerCiudades({ ciudades: ["3", "7"] })).toEqual([3, 7]);
  });

  it("refuses anything that is not two different cities", () => {
    for (const ciudades of [undefined, [], [3], [3, 3], [3, 7, 9], [3, "x"], [0, 7], [3.5, 7], "3,7"]) {
      expect(typeof leerCiudades({ ciudades }), JSON.stringify(ciudades)).toBe("string");
    }
  });
});

describe("POST /api/tramo/", () => {
  it("creates the pair normalised, authored by the session, and answers 201 with the presented tramo", async () => {
    tramo.findOne.mockResolvedValueOnce(null);
    tramo.create.mockResolvedValue(fila());
    tramo.findByPk.mockResolvedValue(fila());
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [7, 3], id_usuario: 99 } }), res);

    expect(tramo.create).toHaveBeenCalledWith(
      { id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, id_usuario: 7 },
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(cuerpo(res).nombre).toBe("Potosí – Sucre");
    expect(tramo.findByPk).toHaveBeenCalledWith(14, expect.objectContaining({ paranoid: false }));
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE_TRAMO", entity: "Tramo" }));
  });

  it("fails with a clear error, not a TypeError, when the row it just created cannot be read back", async () => {
    tramo.findOne.mockResolvedValueOnce(null);
    tramo.create.mockResolvedValue(fila());
    tramo.findByPk.mockResolvedValue(null);
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    const { err } = fallo.mock.calls[0][0] as { err: Error };
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/could not be read back/);
    expect(logAction).not.toHaveBeenCalled();
  });

  it("answers 409 with the tramo that is already there, so the form can select it", async () => {
    tramo.findOne.mockResolvedValue(fila());
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((cuerpo(res).tramo as { id: number }).id).toBe(14);
    expect(tramo.create).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("gives the same 409 when somebody else created it between the look and the write", async () => {
    tramo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(fila());
    tramo.create.mockRejectedValue(Object.assign(new Error("dup"), { name: "SequelizeUniqueConstraintError" }));
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((cuerpo(res).tramo as { id: number }).id).toBe(14);
  });

  it("brings an archived pair back instead of making a second row, with the department sent", async () => {
    permisos.add("tramos.archivar");
    const archivado = fila({ deletedAt: new Date() });
    tramo.findOne.mockResolvedValueOnce(archivado).mockResolvedValueOnce(fila({ id_departamento: 5 }));
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7], id_departamento: 5 } }), res);

    // The two writes are one unit: both carry the transaction.
    expect(archivado.restore).toHaveBeenCalledWith({ transaction: tx });
    expect(archivado.set).toHaveBeenCalledWith({ id_departamento: 5 });
    expect(archivado.save).toHaveBeenCalledWith({ transaction: tx });
    expect(tramo.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "RESTORE_TRAMO" }));
  });

  it("refuses to restore an archived pair to someone who cannot archive: 409, the tramo in the body, nothing written", async () => {
    permisos.add("tramos.crear");
    const archivado = fila({ deletedAt: new Date() });
    tramo.findOne.mockResolvedValueOnce(archivado);
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7], id_departamento: 5 } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(cuerpo(res).message).toMatch(/archivado/);
    expect(cuerpo(res).message).toMatch(/desarchiv/);
    expect((cuerpo(res).tramo as { id: number; archivado: boolean }).id).toBe(14);
    expect((cuerpo(res).tramo as { archivado: boolean }).archivado).toBe(true);
    expect(archivado.restore).not.toHaveBeenCalled();
    expect(archivado.save).not.toHaveBeenCalled();
    expect(tramo.create).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("gives the same refusal when the session has no role at all", async () => {
    permisos.add("tramos.archivar"); // would pass, if there were a role to ask about
    const archivado = fila({ deletedAt: new Date() });
    tramo.findOne.mockResolvedValueOnce(archivado);
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] }, user: { id: 7 } as Request["user"] }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(archivado.restore).not.toHaveBeenCalled();
    expect(archivado.save).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("refuses a city that does not exist, and a department that does not exist, before writing", async () => {
    ciudad.count.mockResolvedValue(1);
    const sinCiudad = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), sinCiudad);
    expect(sinCiudad.status).toHaveBeenCalledWith(400);

    ciudad.count.mockResolvedValue(2);
    departamento.findByPk.mockResolvedValue(null);
    const sinDepartamento = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7], id_departamento: 42 } }), sinDepartamento);
    expect(sinDepartamento.status).toHaveBeenCalledWith(400);
    expect(tramo.create).not.toHaveBeenCalled();
  });
});

describe("PUT /api/tramo/:id", () => {
  it("changes the department of a tramo that has poles", async () => {
    const t = fila();
    tramo.findOne.mockResolvedValue(t);
    tramo.findByPk.mockResolvedValue(fila({ id_departamento: 5, departamento: { id: 5, name: "Potosí" } }));
    poste.count.mockResolvedValue(30);
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { id_departamento: 5 } }), res);

    expect(t.set).toHaveBeenCalledWith({ id_departamento: 5 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "UPDATE_TRAMO" }));
  });

  it("refuses to move the ends of a tramo that has poles, archived ones counted, with the row locked", async () => {
    tramo.findOne.mockResolvedValue(fila());
    poste.count.mockResolvedValue(1);
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(poste.count).toHaveBeenCalledWith(expect.objectContaining({ paranoid: false }));
    // The first look is the plain one; the one that counts is under the lock.
    const bloqueada = tramo.findOne.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((o) => o.lock === "UPDATE");
    expect(bloqueada).toHaveLength(1);
    expect(bloqueada[0].transaction).toBe(tx);
    expect(bloqueada[0]).not.toHaveProperty("include");
    expect(poste.count.mock.calls[0][0].transaction).toBe(tx);
  });

  it("moves the ends in the same transaction that counted the poles", async () => {
    const t = fila();
    tramo.findOne.mockImplementation(async (o: { where: Record<string, unknown> }) => ("id" in o.where ? t : null));
    tramo.findByPk.mockResolvedValue(fila({ id_ciudad_max: 9 }));
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(t.set).toHaveBeenCalledWith({ id_ciudad_min: 3, id_ciudad_max: 9 });
    expect(t.save).toHaveBeenCalledWith({ transaction: tx });
    expect(poste.count.mock.calls[0][0].transaction).toBe(tx);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "UPDATE_TRAMO" }));
  });

  it("answers 409 with the tramo that already joins the new pair, and writes nothing", async () => {
    const t = fila();
    const otro = fila({ id: 30, id_ciudad_max: 9 });
    tramo.findOne.mockImplementation(async (o: { where: Record<string, unknown> }) => ("id" in o.where ? t : otro));
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((cuerpo(res).tramo as { id: number }).id).toBe(30);
    expect(t.save).not.toHaveBeenCalled();
  });

  it("gives the same 409 when two tramos are moved onto the same pair and this one loses the race", async () => {
    // The look finds nothing, the other tramo commits first, and this write
    // meets the unique index inside the transaction.
    const t = fila();
    t.save.mockRejectedValue(Object.assign(new Error("dup"), { name: "SequelizeUniqueConstraintError" }));
    const ganador = fila({ id: 30, id_ciudad_max: 9 });
    let miradasDelPar = 0;
    tramo.findOne.mockImplementation(async (o: { where: Record<string, unknown> }) =>
      "id" in o.where ? t : ++miradasDelPar === 1 ? null : ganador);
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(cuerpo(res).message).toBe("Ese tramo ya existe.");
    expect((cuerpo(res).tramo as { id: number }).id).toBe(30);
    expect(logAction).not.toHaveBeenCalled();
    expect(fallo).not.toHaveBeenCalled();
    // The winner is read after the transaction is over, not inside the one the
    // index just aborted.
    expect(tramo.findOne.mock.calls.at(-1)![0].transaction).toBeUndefined();
  });

  it("tells apart a pair held by an ARCHIVED tramo: same 409 and body, but it must be restored, not selected", async () => {
    const t = fila();
    const archivado = fila({ id: 30, id_ciudad_max: 9, deletedAt: new Date() });
    tramo.findOne.mockImplementation(async (o: { where: Record<string, unknown> }) => ("id" in o.where ? t : archivado));
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(cuerpo(res).message).toMatch(/archivado.*desarch/);
    expect(cuerpo(res).message).not.toBe("Ese tramo ya existe.");
    expect((cuerpo(res).tramo as { id: number; archivado: boolean })).toMatchObject({ id: 30, archivado: true });
    expect(t.save).not.toHaveBeenCalled();
  });

  it("says the same when the archived holder turns up only after the unique index refused", async () => {
    const t = fila();
    t.save.mockRejectedValue(Object.assign(new Error("dup"), { name: "SequelizeUniqueConstraintError" }));
    const ganador = fila({ id: 30, id_ciudad_max: 9, deletedAt: new Date() });
    let miradasDelPar = 0;
    tramo.findOne.mockImplementation(async (o: { where: Record<string, unknown> }) =>
      "id" in o.where ? t : ++miradasDelPar === 1 ? null : ganador);
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(cuerpo(res).message).toMatch(/archivado.*desarch/);
    expect((cuerpo(res).tramo as { id: number })).toMatchObject({ id: 30 });
  });

  it("still answers an error that is not a duplicate as an error", async () => {
    const t = fila();
    t.save.mockRejectedValue(new Error("connection lost"));
    tramo.findOne.mockImplementation(async (o: { where: Record<string, unknown> }) => ("id" in o.where ? t : null));
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logAction).not.toHaveBeenCalled();
  });

  it("does not ask about poles when the ends sent are the ones it already has", async () => {
    const t = fila();
    tramo.findOne.mockResolvedValue(t);
    tramo.findByPk.mockResolvedValue(fila());
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [7, 3] } }), res);

    expect(poste.count).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("DELETE /api/tramo/:id", () => {
  it("refuses while a live pole stands on it, and locks the row to look", async () => {
    tramo.findOne.mockResolvedValue(fila());
    poste.count.mockResolvedValue(4);
    const res = resOf();
    await deleteTramo(reqOf({ params: { id: "14" } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(tramo.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: "UPDATE" }));
    expect(tramo.findOne.mock.calls[0][0].transaction).toBe(tx);
    expect(poste.count.mock.calls[0][0].transaction).toBe(tx);
    expect(logAction).not.toHaveBeenCalled();
  });

  it("archives an empty one and writes it down", async () => {
    const t = fila();
    tramo.findOne.mockResolvedValue(t);
    const res = resOf();
    await deleteTramo(reqOf({ params: { id: "14" } }), res);

    // Lock, count and archive are one unit: all three carry the same transaction.
    expect(tramo.findOne.mock.calls[0][0].transaction).toBe(tx);
    expect(poste.count.mock.calls[0][0].transaction).toBe(tx);
    expect(t.destroy).toHaveBeenCalledWith({ transaction: tx });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "DELETE_TRAMO" }));
  });

  it("answers 404 and logs nothing when there is no such tramo", async () => {
    tramo.findOne.mockResolvedValue(null);
    const res = resOf();
    await deleteTramo(reqOf({ params: { id: "999" } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("GET /api/tramo/:id", () => {
  it("answers 200 with a live tramo", async () => {
    tramo.findByPk.mockResolvedValue(fila());
    const res = resOf();
    await searchTramo(reqOf({ params: { id: "14" } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(cuerpo(res).id).toBe(14);
  });

  it("answers 404 for an archived one, and for an id that is not a number without asking the database", async () => {
    tramo.findByPk.mockResolvedValue(fila({ deletedAt: new Date() }));
    const archivado = resOf();
    await searchTramo(reqOf({ params: { id: "14" } }), archivado);
    expect(archivado.status).toHaveBeenCalledWith(404);

    tramo.findByPk.mockClear();
    const ilegible = resOf();
    await searchTramo(reqOf({ params: { id: "abc" } }), ilegible);
    expect(ilegible.status).toHaveBeenCalledWith(404);
    expect(tramo.findByPk).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/tramo/:id/restore", () => {
  it("restores an archived tramo and writes it down", async () => {
    tramo.findOne.mockResolvedValue(fila({ deletedAt: new Date() }));
    const res = resOf();
    await desarchivarTramo(reqOf({ params: { id: "14" } }), res);

    expect(tramo.restore).toHaveBeenCalledWith({ where: { id: 14 } });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "RESTORE_TRAMO", entity_id: 14 }));
  });

  it("answers 404 and logs nothing when there was nothing to restore, or the id is not a number", async () => {
    tramo.findOne.mockResolvedValue(fila());
    const viva = resOf();
    await desarchivarTramo(reqOf({ params: { id: "14" } }), viva);
    expect(viva.status).toHaveBeenCalledWith(404);

    tramo.findOne.mockClear();
    const ilegible = resOf();
    await desarchivarTramo(reqOf({ params: { id: "14abc" } }), ilegible);
    expect(ilegible.status).toHaveBeenCalledWith(404);
    expect(tramo.findOne).not.toHaveBeenCalled();
    expect(tramo.restore).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("GET /api/tramo/", () => {
  beforeEach(() => tramo.findAndCountAll.mockResolvedValue({ count: 1, rows: [fila({ postes: 12 })] }));

  const opciones = () => tramo.findAndCountAll.mock.calls[0][0] as {
    where: Record<string, unknown>; attributes: { include?: unknown[] } | string[];
  };

  it("counts poles only for a role that may read poles", async () => {
    const sin = resOf();
    await getTramo(reqOf(), sin);
    expect(JSON.stringify(opciones().attributes)).not.toContain("postes");
    expect((cuerpo(sin).data as Record<string, unknown>[])[0]).not.toHaveProperty("postes");

    tramo.findAndCountAll.mockClear();
    permisos.add("postes.ver");
    const con = resOf();
    await getTramo(reqOf(), con);
    expect((cuerpo(con).data as { postes: number }[])[0].postes).toBe(12);
  });

  it("counts pending incidents only for a role that may read incidents, whatever it may read of poles", async () => {
    tramo.findAndCountAll.mockResolvedValue({ count: 1, rows: [fila({ postes: 12, pendientes: 3 })] });

    // Poles and not incidents: the pole figure travels, the other does not.
    permisos.add("postes.ver");
    const sin = resOf();
    await getTramo(reqOf(), sin);
    expect(JSON.stringify(opciones().attributes)).not.toContain("pendientes");
    expect((cuerpo(sin).data as Record<string, unknown>[])[0]).not.toHaveProperty("pendientes");
    expect((cuerpo(sin).data as { postes: number }[])[0].postes).toBe(12);

    // Incidents and not poles: the other way round. Neither permission implies the other.
    tramo.findAndCountAll.mockClear();
    permisos.delete("postes.ver");
    permisos.add("eventos.ver");
    const con = resOf();
    await getTramo(reqOf(), con);
    expect((cuerpo(con).data as { pendientes: number }[])[0].pendientes).toBe(3);
    expect((cuerpo(con).data as Record<string, unknown>[])[0]).not.toHaveProperty("postes");
  });

  it("counts as pending what the cities' list counts: live incidents not solved, on live poles", async () => {
    permisos.add("eventos.ver");
    await getTramo(reqOf(), resOf());

    // The literal's own text: a mocked model cannot run it, and the three
    // conditions are each a way of counting something that is not there.
    const sql = JSON.stringify(opciones().attributes);
    expect(sql).toContain(`\\"eventos\\".\\"state\\" IS NOT TRUE`);
    expect(sql).toContain(`\\"eventos\\".\\"deletedAt\\" IS NULL`);
    expect(sql).toContain(`\\"postes\\".\\"deletedAt\\" IS NULL`);
    expect(sql).toContain(`\\"postes\\".\\"id_tramo\\" = \\"tramo\\".\\"id\\"`);
  });

  it("answers zero pending, not nothing, for a tramo that has none", async () => {
    tramo.findAndCountAll.mockResolvedValue({ count: 1, rows: [fila({ pendientes: 0 })] });
    permisos.add("eventos.ver");
    const res = resOf();
    await getTramo(reqOf(), res);

    expect((cuerpo(res).data as { pendientes: number }[])[0].pendientes).toBe(0);
  });

  it("filters by a department, and by having none", async () => {
    await getTramo(reqOf({ query: { departamento: "5" } }), resOf());
    expect(opciones().where).toMatchObject({ id_departamento: 5 });

    tramo.findAndCountAll.mockClear();
    await getTramo(reqOf({ query: { departamento: "ninguno" } }), resOf());
    expect(opciones().where).toMatchObject({ id_departamento: null });
  });

  it("refuses a department it cannot read rather than ignoring the filter", async () => {
    const res = resOf();
    await getTramo(reqOf({ query: { departamento: "abc" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(tramo.findAndCountAll).not.toHaveBeenCalled();
  });

  it("refuses an EMPTY department as it refuses any other unreadable one; absent stays no filter", async () => {
    const res = resOf();
    await getTramo(reqOf({ query: { departamento: "" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(cuerpo(res).message).toBe("El departamento indicado no es válido.");
    expect(tramo.findAndCountAll).not.toHaveBeenCalled();

    await getTramo(reqOf({ query: {} }), resOf());
    expect(opciones().where).not.toHaveProperty("id_departamento");
  });

  it("orders by the name under the same collation the name is built with", async () => {
    await getTramo(reqOf(), resOf());
    const orden = (tramo.findAndCountAll.mock.calls[0][0] as { order: unknown[][] }).order;
    expect((orden[0][0] as { val: string }).val).toMatch(/\) COLLATE "C"$/);
  });

  it("answers the envelope with presented rows", async () => {
    const res = resOf();
    await getTramo(reqOf(), res);
    expect(Object.keys(cuerpo(res)).sort()).toEqual(["data", "limit", "page", "total"]);
    expect((cuerpo(res).data as { nombre: string }[])[0].nombre).toBe("Potosí – Sucre");
  });
});
