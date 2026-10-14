// Who may do what to a schedule, and what the database is asked before a
// request is believed. The handlers are called directly with a fake request:
// the gates in front of them are `routeGuards.test.ts`'s business, and the
// shape of the body is `reportSchedule/payload.test.ts`'s.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const can = vi.fn(async (_rol: number, _modulo: string, _accion: string) => false);
vi.mock("../permissions/store.js", () => ({ can: (...a: [number, string, string]) => can(...a) }));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
// One logger for the whole file, so that a test can ask what was warned.
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ log: () => logger }));

const ejecutarTurno = vi.fn();
vi.mock("../reportSchedule/run.js", () => ({ ejecutarTurno: (...a: unknown[]) => ejecutarTurno(...a) }));
vi.mock("../reportSchedule/runtime.js", () => ({ dependenciasDeInformes: () => ({ falsas: true }) }));

const { sequelize } = await import("../database/sequelize.js");
vi.spyOn(sequelize, "transaction").mockImplementation((async (cb: (t: unknown) => Promise<unknown>) => cb({ id: "t" })) as never);

const { ReporteProgramacionModel, ReporteProgramacionDestinatarioModel, ReporteEjecucionModel, ReporteEntregaModel } = await import(
  "../models/reporteProgramacion.model.js"
);
const { ReporteVistaModel } = await import("../models/reporteVista.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");

const programacionFindByPk = vi.spyOn(ReporteProgramacionModel, "findByPk");
const programacionCreate = vi.spyOn(ReporteProgramacionModel, "create");
const destinatariosFindAll = vi.spyOn(ReporteProgramacionDestinatarioModel, "findAll");
const destinatariosBulkCreate = vi.spyOn(ReporteProgramacionDestinatarioModel, "bulkCreate");
const destinatariosDestroy = vi.spyOn(ReporteProgramacionDestinatarioModel, "destroy");
const ejecucionesFindAll = vi.spyOn(ReporteEjecucionModel, "findAll");
const entregasFindAll = vi.spyOn(ReporteEntregaModel, "findAll");
const informeFindByPk = vi.spyOn(ReporteVistaModel, "findByPk");
const informeFindAll = vi.spyOn(ReporteVistaModel, "findAll");
const usuarioCount = vi.spyOn(UsuarioModel, "count");
const usuarioFindAll = vi.spyOn(UsuarioModel, "findAll");

const {
  deleteProgramacion,
  getDestinatariosDeEjecucion,
  getEjecucionesDeProgramacion,
  getHistorialDeEjecuciones,
  postEjecutarProgramacion,
  postProgramacion,
  putProgramacion,
} = await import("./programacion.controller.js");

const YO = 7;
const OTRA = 8;

const BUENA = {
  id_reporte: 3,
  frecuencia: "diaria",
  hora: 7,
  formato: "excel",
  destinatarios: { usuarios: [20], correos: ["cliente@fuera.com"] },
};

function peticion(over: { body?: unknown; id?: string; query?: Record<string, string> } = {}) {
  return {
    body: over.body,
    params: over.id ? { id: over.id } : {},
    query: over.query ?? {},
    user: { id: YO, id_rol: 2 },
    ip: "10.0.0.1",
  } as unknown as Request;
}

function respuesta() {
  const res = { statusCode: 0, body: undefined as unknown, terminada: false } as {
    statusCode: number;
    body: unknown;
    terminada: boolean;
    status(c: number): typeof res;
    json(b: unknown): typeof res;
    end(): typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.end = () => ((res.terminada = true), res);
  return res;
}
const como = (res: ReturnType<typeof respuesta>) => res as unknown as Response;

/** A stored schedule, as `findByPk` hands it over. */
function guardada(over: Record<string, unknown> = {}) {
  const dataValues = {
    id: 5,
    id_reporte: 3,
    id_usuario: YO,
    frecuencia: "diaria",
    dia_semana: null,
    dia_mes: null,
    hora: 7,
    formato: "excel",
    con_fotos: false,
    activa: true,
    motivo_pausa: null,
    fallos_seguidos: 0,
    proxima_ejecucion: new Date("2026-03-16T11:00:00Z"),
    ...over,
  };
  const fila = {
    dataValues,
    update: vi.fn(async (cambios: Record<string, unknown>) => Object.assign(dataValues, cambios)),
    destroy: vi.fn(async () => undefined),
    reload: vi.fn(async () => fila),
  };
  return fila;
}

beforeEach(() => {
  vi.clearAllMocks();
  can.mockResolvedValue(false);
  informeFindByPk.mockResolvedValue({ dataValues: { id: 3, id_usuario: YO, visibility: "private" } } as never);
  informeFindAll.mockResolvedValue([{ dataValues: { id: 3, name: "Informe semanal" } }] as never);
  usuarioCount.mockResolvedValue(1 as never);
  usuarioFindAll.mockResolvedValue([] as never);
  destinatariosFindAll.mockResolvedValue([] as never);
  destinatariosBulkCreate.mockResolvedValue([] as never);
  destinatariosDestroy.mockResolvedValue(0 as never);
  ejecucionesFindAll.mockResolvedValue([] as never);
  entregasFindAll.mockResolvedValue([] as never);
  programacionCreate.mockImplementation((async (valores: Record<string, unknown>) => ({ dataValues: { id: 5, fallos_seguidos: 0, ...valores } })) as never);
});

describe("creating a schedule", () => {
  it("belongs to whoever created it, whatever the body says", async () => {
    const res = respuesta();
    await postProgramacion(peticion({ body: { ...BUENA, id_usuario: OTRA } }), como(res));

    expect(res.statusCode).toBe(201);
    expect(programacionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: YO, id_reporte: 3, activa: true });
    expect((programacionCreate.mock.calls[0][0] as { proxima_ejecucion: Date }).proxima_ejecucion).toBeInstanceOf(Date);
  });

  it("writes its recipients in the same transaction", async () => {
    await postProgramacion(peticion({ body: BUENA }), como(respuesta()));
    expect(destinatariosBulkCreate).toHaveBeenCalledWith(
      [{ id_programacion: 5, id_usuario: 20 }, { id_programacion: 5, email: "cliente@fuera.com" }],
      { transaction: { id: "t" } },
    );
    expect(programacionCreate.mock.calls[0][1]).toEqual({ transaction: { id: "t" } });
  });

  it("is created paused, with no next run, when it is asked for that way", async () => {
    await postProgramacion(peticion({ body: { ...BUENA, activa: false } }), como(respuesta()));
    expect(programacionCreate.mock.calls[0][0]).toMatchObject({ activa: false, proxima_ejecucion: null, motivo_pausa: "manual" });
  });

  it("records who it sends to, the outside addresses in full, and as a warning when there are any", async () => {
    await postProgramacion(peticion({ body: BUENA }), como(respuesta()));
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE_PROGRAMACION",
        entity: "ReporteProgramacion",
        entity_id: 5,
        severity: "warning",
        metadata: expect.objectContaining({ usuarios: [20], correos_externos: ["cliente@fuera.com"] }),
      }),
    );

    logAction.mockClear();
    await postProgramacion(peticion({ body: { ...BUENA, destinatarios: { usuarios: [20] } } }), como(respuesta()));
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ severity: "info" }));
  });

  it("answers 400 with every problem in one sentence, and writes nothing", async () => {
    const res = respuesta();
    await postProgramacion(peticion({ body: { ...BUENA, hora: 99, formato: "csv" } }), como(res));
    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/hora.*formato|formato.*hora/s);
    expect(programacionCreate).not.toHaveBeenCalled();
  });

  it("answers 404, not 403, for somebody else's private report: a schedule must not reveal which ids exist", async () => {
    informeFindByPk.mockResolvedValue({ dataValues: { id: 3, id_usuario: OTRA, visibility: "private" } } as never);
    const res = respuesta();
    await postProgramacion(peticion({ body: BUENA }), como(res));
    expect(res.statusCode).toBe(404);
    expect(programacionCreate).not.toHaveBeenCalled();

    informeFindByPk.mockResolvedValue(null as never);
    const res2 = respuesta();
    await postProgramacion(peticion({ body: BUENA }), como(res2));
    expect([res2.statusCode, res2.body]).toEqual([res.statusCode, res.body]);
  });

  it("accepts somebody else's report when it is shared", async () => {
    informeFindByPk.mockResolvedValue({ dataValues: { id: 3, id_usuario: OTRA, visibility: "shared" } } as never);
    const res = respuesta();
    await postProgramacion(peticion({ body: BUENA }), como(res));
    expect(res.statusCode).toBe(201);
  });

  it("refuses a recipient account that does not exist", async () => {
    usuarioCount.mockResolvedValue(0 as never);
    const res = respuesta();
    await postProgramacion(peticion({ body: BUENA }), como(res));
    expect(res.statusCode).toBe(400);
    expect(programacionCreate).not.toHaveBeenCalled();
  });

  it("answers 500 without the database's words when the write fails", async () => {
    programacionCreate.mockRejectedValue(new Error('relation "reporte_programaciones" violates check constraint') as never);
    const res = respuesta();
    await postProgramacion(peticion({ body: BUENA }), como(res));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|constraint/);
  });
});

describe("changing a schedule", () => {
  it("is refused to anybody but its owner — administration included — and the attempt is recorded", async () => {
    can.mockResolvedValue(true); // moderation changes nothing here
    const fila = guardada({ id_usuario: OTRA });
    programacionFindByPk.mockResolvedValue(fila as never);
    const res = respuesta();
    await putProgramacion(peticion({ id: "5", body: BUENA }), como(res));

    expect(res.statusCode).toBe(403);
    expect(fila.update).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "EDIT_PROGRAMACION_DENIED", entity_id: 5 }));
  });

  it("answers 404 for one that does not exist, and for an id that is not a number", async () => {
    programacionFindByPk.mockResolvedValue(null as never);
    for (const id of ["99", "abc", "0", "1.5"]) {
      const res = respuesta();
      await putProgramacion(peticion({ id, body: BUENA }), como(res));
      expect(res.statusCode, id).toBe(404);
    }
  });

  it("keeps an unsubscribed address and removes the rest that are no longer asked for", async () => {
    const fila = guardada();
    programacionFindByPk.mockResolvedValue(fila as never);
    destinatariosFindAll.mockResolvedValue([
      { dataValues: { id: 1, id_programacion: 5, id_usuario: 20, email: null, baja_at: null, rechazos_seguidos: 0 } },
      { dataValues: { id: 2, id_programacion: 5, id_usuario: null, email: "baja@fuera.com", baja_at: new Date(), rechazos_seguidos: 0 } },
      { dataValues: { id: 3, id_programacion: 5, id_usuario: null, email: "viejo@fuera.com", baja_at: null, rechazos_seguidos: 0 } },
    ] as never);

    const res = respuesta();
    await putProgramacion(
      peticion({ id: "5", body: { ...BUENA, destinatarios: { usuarios: [20], correos: ["nuevo@fuera.com", "baja@fuera.com"] } } }),
      como(res),
    );

    expect(res.statusCode).toBe(200);
    expect(destinatariosDestroy).toHaveBeenCalledWith({ where: { id: [3] }, transaction: { id: "t" } });
    expect(destinatariosBulkCreate).toHaveBeenCalledWith(
      [{ id_programacion: 5, email: "nuevo@fuera.com" }],
      { transaction: { id: "t" } },
    );
  });

  it("leaves the next run where it was when only the recipients changed", async () => {
    const fila = guardada();
    const antes = fila.dataValues.proxima_ejecucion;
    programacionFindByPk.mockResolvedValue(fila as never);
    await putProgramacion(peticion({ id: "5", body: BUENA }), como(respuesta()));
    expect(fila.update.mock.calls[0][0]).toMatchObject({ proxima_ejecucion: antes, activa: true, motivo_pausa: null });
  });

  it("pausing clears the next run in the same write, as the table demands", async () => {
    const fila = guardada();
    programacionFindByPk.mockResolvedValue(fila as never);
    await putProgramacion(peticion({ id: "5", body: { ...BUENA, activa: false } }), como(respuesta()));
    expect(fila.update.mock.calls[0][0]).toMatchObject({ activa: false, proxima_ejecucion: null, motivo_pausa: "manual" });
  });
});

describe("removing a schedule", () => {
  it("lets the owner, stopping it before archiving it", async () => {
    const fila = guardada();
    programacionFindByPk.mockResolvedValue(fila as never);
    const res = respuesta();
    await deleteProgramacion(peticion({ id: "5" }), como(res));

    expect([res.statusCode, res.terminada, res.body]).toEqual([204, true, undefined]);
    expect(fila.update).toHaveBeenCalledWith(
      { activa: false, proxima_ejecucion: null, motivo_pausa: "manual" },
      { transaction: { id: "t" } },
    );
    expect(fila.update.mock.invocationCallOrder[0]).toBeLessThan(fila.destroy.mock.invocationCallOrder[0]);
  });

  it("lets administration remove somebody else's, and says so in the record", async () => {
    can.mockImplementation(async (_rol, modulo, accion) => modulo === "seguridad" && accion === "editar");
    const fila = guardada({ id_usuario: OTRA });
    programacionFindByPk.mockResolvedValue(fila as never);
    const res = respuesta();
    await deleteProgramacion(peticion({ id: "5" }), como(res));

    expect(res.statusCode).toBe(204);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DELETE_PROGRAMACION", detail: expect.stringMatching(/de otra persona/) }),
    );
  });

  it("refuses anybody else", async () => {
    const fila = guardada({ id_usuario: OTRA });
    programacionFindByPk.mockResolvedValue(fila as never);
    const res = respuesta();
    await deleteProgramacion(peticion({ id: "5" }), como(res));
    expect(res.statusCode).toBe(403);
    expect(fila.destroy).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "DELETE_PROGRAMACION_DENIED" }));
  });
});

describe("\"send it now\"", () => {
  it("runs the owner's schedule as a manual run and answers with what happened", async () => {
    programacionFindByPk.mockResolvedValue(guardada() as never);
    ejecutarTurno.mockResolvedValue({ tipo: "ejecutado", estado: "enviado", enviados: 2, no_enviados: 0 });
    const res = respuesta();
    await postEjecutarProgramacion(peticion({ id: "5" }), como(res));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tipo: "ejecutado", estado: "enviado", enviados: 2, no_enviados: 0 });
    expect(ejecutarTurno).toHaveBeenCalledWith(
      { falsas: true },
      expect.objectContaining({ id: 5, id_usuario: YO, formato: "excel" }),
      expect.any(Date),
      { manual: true },
    );
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "RUN_PROGRAMACION" }));
  });

  it("is refused to anybody but the owner, administration included, and nothing is sent", async () => {
    can.mockResolvedValue(true);
    programacionFindByPk.mockResolvedValue(guardada({ id_usuario: OTRA }) as never);
    const res = respuesta();
    await postEjecutarProgramacion(peticion({ id: "5" }), como(res));
    expect(res.statusCode).toBe(403);
    expect(ejecutarTurno).not.toHaveBeenCalled();
  });

  it("answers 429 when the exporter is busy and 409 when that run is already going", async () => {
    programacionFindByPk.mockResolvedValue(guardada() as never);
    ejecutarTurno.mockResolvedValueOnce({ tipo: "ocupado" }).mockResolvedValueOnce({ tipo: "ya_reclamado" });
    const ocupado = respuesta();
    await postEjecutarProgramacion(peticion({ id: "5" }), como(ocupado));
    const repetido = respuesta();
    await postEjecutarProgramacion(peticion({ id: "5" }), como(repetido));
    expect([ocupado.statusCode, repetido.statusCode]).toEqual([429, 409]);
  });

  it("says so when the attempt left the schedule paused instead of sending", async () => {
    programacionFindByPk.mockResolvedValue(guardada() as never);
    ejecutarTurno.mockResolvedValue({ tipo: "pausada", motivo: "sin_destinatarios" });
    const res = respuesta();
    await postEjecutarProgramacion(peticion({ id: "5" }), como(res));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tipo: "pausada", motivo: "sin_destinatarios" });
  });
});

describe("a schedule's history", () => {
  it("is refused to somebody who neither owns it nor moderates, and the attempt is recorded", async () => {
    programacionFindByPk.mockResolvedValue({ dataValues: { id: 5, id_usuario: OTRA } } as never);
    const res = respuesta();
    await getEjecucionesDeProgramacion(peticion({ id: "5" }), como(res));
    expect(res.statusCode).toBe(403);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "READ_PROGRAMACION_DENIED" }));
  });

  it("is read by its owner and by administration", async () => {
    const contar = vi.spyOn(ReporteEjecucionModel, "findAndCountAll").mockResolvedValue({ count: 0, rows: [] } as never);
    programacionFindByPk.mockResolvedValue({ dataValues: { id: 5, id_usuario: YO } } as never);
    const propio = respuesta();
    await getEjecucionesDeProgramacion(peticion({ id: "5" }), como(propio));

    can.mockResolvedValue(true);
    programacionFindByPk.mockResolvedValue({ dataValues: { id: 5, id_usuario: OTRA } } as never);
    const moderado = respuesta();
    await getEjecucionesDeProgramacion(peticion({ id: "5" }), como(moderado));

    expect([propio.statusCode, moderado.statusCode]).toEqual([200, 200]);
    expect(contar.mock.calls[0][0]).toMatchObject({ where: { id_programacion: 5 } });
  });
});

describe("the history of every schedule", () => {
  const contar = vi.spyOn(ReporteEjecucionModel, "findAndCountAll");
  const OPCIONES = () =>
    contar.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      order: unknown;
      include: { where?: Record<string, unknown>; required?: boolean; paranoid?: boolean; attributes?: string[] }[];
    };

  /** A run as the query hands it over, with the schedule it joined. */
  function corrida(over: Record<string, unknown> = {}, programacion: Record<string, unknown> = {}) {
    return {
      dataValues: {
        id: 90,
        id_programacion: 5,
        programada_para: new Date("2026-10-12T07:00:00Z"),
        manual: false,
        estado: "enviado",
        iniciada_at: new Date("2026-10-12T07:00:01Z"),
        terminada_at: new Date("2026-10-12T07:00:09Z"),
        filas: 120,
        bytes: 2048,
        enviados: 2,
        no_enviados: 0,
        detalle: null,
        reporteProgramacion: {
          dataValues: { id: 5, id_reporte: 3, id_usuario: YO, formato: "excel", deleted_at: null, ...programacion },
        },
        ...over,
      },
    };
  }
  const devuelve = (...filas: ReturnType<typeof corrida>[]) =>
    contar.mockResolvedValue({ count: filas.length, rows: filas } as never);
  const pedir = async (query: Record<string, string> = {}) => {
    const res = respuesta();
    await getHistorialDeEjecuciones(peticion({ query }), como(res));
    return res;
  };

  beforeEach(() => {
    contar.mockReset();
    devuelve();
    usuarioFindAll.mockResolvedValue([{ dataValues: { id: YO, name: "Ana", lastname: "Pérez" } }] as never);
  });

  describe("who sees which runs", () => {
    it("narrows somebody who cannot moderate to the schedules they own, inside the query", async () => {
      const res = await pedir();
      expect(res.statusCode).toBe(200);
      const [inc] = OPCIONES().include;
      expect(inc.where).toEqual({ id_usuario: YO });
      // An inner join: a run of a schedule outside that condition is not a
      // row at all, whichever page it would have fallen on.
      expect(inc.required).toBe(true);
    });

    it("does not narrow a moderator", async () => {
      can.mockImplementation(async (_rol, modulo, accion) => modulo === "seguridad" && accion === "editar");
      await pedir();
      const [inc] = OPCIONES().include;
      expect(inc.where ?? {}).toEqual({});
      expect(inc.required).toBe(true);
    });

    it("cannot be widened by naming somebody else's schedule: the owner condition stays", async () => {
      await pedir({ id_programacion: "99" });
      expect(OPCIONES().where).toEqual({ id_programacion: 99 });
      expect(OPCIONES().include[0].where).toEqual({ id_usuario: YO });
    });

    it("answers an empty page, not a 403, for a schedule the viewer may not see", async () => {
      contar.mockResolvedValue({ count: 0, rows: [] } as never);
      const res = await pedir({ id_programacion: "99" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ data: [], total: 0, page: 1, limit: 50 });
      expect(logAction).not.toHaveBeenCalled();
    });

    it("keeps the runs of a schedule that was deleted: the join does not hide archived rows", async () => {
      await pedir();
      expect(OPCIONES().include[0].paranoid).toBe(false);
    });
  });

  describe("what can be asked", () => {
    it("lists newest first, and by id within the same instant so that pages do not overlap", async () => {
      await pedir();
      expect(OPCIONES().order).toEqual([["programada_para", "DESC"], ["id", "DESC"]]);
    });

    it("sends no filter when none was asked for", async () => {
      await pedir();
      expect(OPCIONES().where).toEqual({});
    });

    it("filters by result", async () => {
      await pedir({ estado: "fallido" });
      expect(OPCIONES().where).toEqual({ estado: "fallido" });
    });

    it("filters by schedule, and the two together", async () => {
      await pedir({ id_programacion: "5", estado: "omitido" });
      expect(OPCIONES().where).toEqual({ id_programacion: 5, estado: "omitido" });
    });

    it.each(["en_curso", "enviado", "vacio", "demasiado_grande", "fallido", "omitido"])("accepts the result %s", async (estado) => {
      expect((await pedir({ estado })).statusCode).toBe(200);
    });

    it.each([
      ["estado", ""],
      ["estado", "nope"],
      ["id_programacion", ""],
      ["id_programacion", "0"],
      ["id_programacion", "-3"],
      ["id_programacion", "abc"],
      ["id_programacion", "1.5"],
      ["id_programacion", "99999999999"],
    ])("answers 400, and asks nothing, for %s=%s", async (clave, valor) => {
      const res = await pedir({ [clave]: valor });
      expect(res.statusCode).toBe(400);
      expect((res.body as { message: string }).message).toMatch(new RegExp(clave));
      expect(contar).not.toHaveBeenCalled();
    });

    it("answers 400 for a repeated parameter, which Express reads as an array", async () => {
      const res = respuesta();
      await getHistorialDeEjecuciones(
        { query: { estado: ["enviado", "fallido"] }, user: { id: YO, id_rol: 2 } } as unknown as Request,
        como(res),
      );
      expect(res.statusCode).toBe(400);
      expect(contar).not.toHaveBeenCalled();
    });

    it("pages like every other listing, and refuses an unreadable page", async () => {
      await pedir({ page: "3", limit: "10" });
      expect(contar.mock.calls[0][0]).toMatchObject({ limit: 10, offset: 20 });
      contar.mockClear();
      expect((await pedir({ limit: "" })).statusCode).toBe(400);
      expect(contar).not.toHaveBeenCalled();
    });
  });

  describe("what a row says", () => {
    it("serves the run's own fields as the per-schedule history does, and the schedule beside them", async () => {
      devuelve(corrida());
      informeFindAll.mockResolvedValue([{ dataValues: { id: 3, name: "Informe semanal", deletedAt: null } }] as never);
      const res = await pedir();

      const { reporteProgramacion: _fuera, ...propios } = corrida().dataValues;
      expect(res.body).toEqual({
        data: [
          {
            ...propios,
            con_destinatarios: false,
            programacion: {
              id: 5,
              formato: "excel",
              eliminada: false,
              informe: { id: 3, name: "Informe semanal" },
              dueno: { id: YO, name: "Ana", lastname: "Pérez" },
            },
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
      });
    });

    it("serves a deleted schedule's run, flagged", async () => {
      devuelve(corrida({}, { deleted_at: new Date("2026-10-01T00:00:00Z") }));
      const res = await pedir();
      const [fila] = (res.body as { data: { programacion: { eliminada: boolean } }[] }).data;
      expect(fila.programacion.eliminada).toBe(true);
    });

    it("serves informe: null for a report that is gone, and still the run", async () => {
      devuelve(corrida());
      informeFindAll.mockResolvedValue([] as never);
      const res = await pedir();
      const [fila] = (res.body as { data: { id: number; programacion: { informe: unknown } }[] }).data;
      expect(fila.id).toBe(90);
      expect(fila.programacion.informe).toBeNull();
    });

    it("serves dueno: null for an owner that cannot be found", async () => {
      devuelve(corrida());
      usuarioFindAll.mockResolvedValue([] as never);
      const res = await pedir();
      expect((res.body as { data: { programacion: { dueno: unknown } }[] }).data[0].programacion.dueno).toBeNull();
    });

    it("reads the report and the owner archived or not, in one query each for the whole page", async () => {
      devuelve(corrida(), corrida({ id: 89 }, { id: 6, id_reporte: 4, id_usuario: OTRA }));
      await pedir();
      expect(informeFindAll).toHaveBeenCalledTimes(1);
      expect(informeFindAll.mock.calls[0][0]).toMatchObject({ where: { id: [3, 4] }, attributes: ["id", "name"], paranoid: false });
      expect(usuarioFindAll).toHaveBeenCalledTimes(1);
      expect(usuarioFindAll.mock.calls[0][0]).toMatchObject({ where: { id: [YO, OTRA] }, attributes: ["id", "name", "lastname"], paranoid: false });
    });

    it("never carries an e-mail address, nor any field of the account beyond its name", async () => {
      devuelve(corrida());
      usuarioFindAll.mockResolvedValue([
        { dataValues: { id: YO, name: "Ana", lastname: "Pérez", email: "ana@osefi.net", email_verified_at: new Date() } },
      ] as never);
      const res = await pedir();
      expect(JSON.stringify(res.body)).not.toMatch(/@|email/);
    });

    it("asks nothing more when the page is empty", async () => {
      await pedir();
      expect(informeFindAll).not.toHaveBeenCalled();
      expect(usuarioFindAll).not.toHaveBeenCalled();
    });

    it("answers 422 when limit=all is too large, and 500 without the database's words on a failure", async () => {
      contar.mockResolvedValue({ count: 9000, rows: [] } as never);
      expect((await pedir({ limit: "all" })).statusCode).toBe(422);
      contar.mockRejectedValue(new Error('relation "reporte_ejecuciones" does not exist') as never);
      const res = await pedir();
      expect(res.statusCode).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/relation/);
    });
  });
});

describe("who each run was sent to", () => {
  const contar = vi.spyOn(ReporteEntregaModel, "findAndCountAll");
  const ejecucionFindByPk = vi.spyOn(ReporteEjecucionModel, "findByPk");

  /** The run as the first read hands it over: itself, and the schedule it belongs to. */
  const ejecucionDe = (id_usuario: number) => ({
    dataValues: { id: 90, reporteProgramacion: { dataValues: { id: 5, id_usuario } } },
  });
  const entrega = (over: Record<string, unknown> = {}) => ({
    dataValues: {
      id: 1, id_ejecucion: 90, tipo: "usuario", id_usuario: 20, correo: null, nombre: "Beto Mamani",
      resultado: "entregado", created_at: new Date("2026-10-12T11:00:02Z"), ...over,
    },
  });
  const pedir = async (id = "90", query: Record<string, string> = {}) => {
    const res = respuesta();
    await getDestinatariosDeEjecucion(peticion({ id, query }), como(res));
    return res;
  };
  const OPCIONES = () =>
    contar.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      order: unknown;
      include: { required?: boolean; paranoid?: boolean; where?: unknown; include?: { where?: unknown; required?: boolean; paranoid?: boolean }[] }[];
    };

  beforeEach(() => {
    contar.mockReset();
    contar.mockResolvedValue({ count: 0, rows: [] } as never);
    ejecucionFindByPk.mockReset();
    ejecucionFindByPk.mockResolvedValue(ejecucionDe(YO) as never);
  });

  it("answers 404 for a run that does not exist, and for an id that is not a number", async () => {
    ejecucionFindByPk.mockResolvedValue(null as never);
    for (const id of ["99", "abc", "0", "1.5"]) {
      const res = await pedir(id);
      expect(res.statusCode, id).toBe(404);
    }
    expect(contar).not.toHaveBeenCalled();
  });

  it("is refused, and the attempt recorded, to somebody who neither owns the run's schedule nor moderates", async () => {
    ejecucionFindByPk.mockResolvedValue(ejecucionDe(OTRA) as never);
    const res = await pedir();
    expect(res.statusCode).toBe(403);
    expect(contar).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "READ_PROGRAMACION_DENIED", entity: "ReporteProgramacion" }));
  });

  it("is read by the owner, and by administration for somebody else's", async () => {
    expect((await pedir()).statusCode).toBe(200);
    can.mockImplementation(async (_rol, modulo, accion) => modulo === "seguridad" && accion === "editar");
    ejecucionFindByPk.mockResolvedValue(ejecucionDe(OTRA) as never);
    expect((await pedir()).statusCode).toBe(200);
  });

  it("reads the schedule of a deleted run's owner too: the first read does not hide archived schedules", async () => {
    await pedir();
    expect(ejecucionFindByPk.mock.calls[0][1]).toMatchObject({ include: [expect.objectContaining({ paranoid: false })] });
  });

  it("scopes the read itself to the schedules the viewer owns, so that the check above is not the only thing in the way", async () => {
    await pedir();
    const opciones = OPCIONES();
    expect(opciones.where).toEqual({ id_ejecucion: 90 });
    const [ejecucion] = opciones.include;
    expect(ejecucion.required).toBe(true);
    expect(ejecucion.include?.[0]).toMatchObject({ required: true, paranoid: false, where: { id_usuario: YO } });
  });

  it("does not scope a moderator", async () => {
    can.mockImplementation(async (_rol, modulo, accion) => modulo === "seguridad" && accion === "editar");
    await pedir();
    expect(OPCIONES().include[0].include?.[0].where ?? {}).toEqual({});
  });

  it("lists them in the order they were written", async () => {
    await pedir();
    expect(OPCIONES().order).toEqual([["id", "ASC"]]);
  });

  it("answers the house envelope, with each recipient as {id, tipo, nombre, resultado}", async () => {
    contar.mockResolvedValue({
      count: 2,
      rows: [entrega(), entrega({ id: 2, tipo: "externo", id_usuario: null, correo: "cliente@fuera.com", nombre: "cliente@fuera.com", resultado: "rechazado" })],
    } as never);
    const res = await pedir();
    expect(res.body).toEqual({
      data: [
        { id: 1, tipo: "usuario", nombre: "Beto Mamani", resultado: "entregado" },
        // An outside recipient is called by its address: that is its `nombre`, and there is no second field for it.
        { id: 2, tipo: "externo", nombre: "cliente@fuera.com", resultado: "rechazado" },
      ],
      total: 2, page: 1, limit: 50,
    });
  });

  it("serves no address field at all, and none of an account even if its row somehow carried one", async () => {
    contar.mockResolvedValue({
      count: 1,
      rows: [entrega({ correo: "beto@osefi.net" })],
    } as never);
    const res = await pedir();
    expect(JSON.stringify(res.body)).not.toContain("beto@osefi.net");
    expect(JSON.stringify(res.body)).not.toContain("correo");
  });

  it("does not serve the account behind an account's row, nor when it was written", async () => {
    contar.mockResolvedValue({ count: 1, rows: [entrega()] } as never);
    const res = await pedir();
    expect(Object.keys((res.body as { data: object[] }).data[0]).sort()).toEqual(["id", "nombre", "resultado", "tipo"]);
  });

  it("answers 500 without the database's words when the read fails", async () => {
    contar.mockRejectedValue(new Error('relation "reporte_ejecucion_entregas" does not exist'));
    const res = await pedir();
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
  });
});

describe("telling an old run from a new one in the history", () => {
  const contar = vi.spyOn(ReporteEjecucionModel, "findAndCountAll");
  const fila = (id: number) => ({
    dataValues: {
      id, id_programacion: 5, programada_para: new Date("2026-10-12T07:00:00Z"), manual: false, estado: "enviado",
      iniciada_at: new Date(), terminada_at: new Date(), filas: 1, bytes: 1, enviados: 1, no_enviados: 0, detalle: null,
      reporteProgramacion: { dataValues: { id: 5, id_reporte: 3, id_usuario: YO, formato: "excel", deleted_at: null } },
    },
  });

  beforeEach(() => {
    contar.mockReset();
    usuarioFindAll.mockResolvedValue([{ dataValues: { id: YO, name: "Ana", lastname: "Pérez" } }] as never);
  });

  it("marks the runs that have recipients recorded, with one read for the whole page", async () => {
    contar.mockResolvedValue({ count: 3, rows: [fila(92), fila(91), fila(90)] } as never);
    entregasFindAll.mockResolvedValue([{ dataValues: { id_ejecucion: 92 } }, { dataValues: { id_ejecucion: 90 } }] as never);
    const res = respuesta();
    await getHistorialDeEjecuciones(peticion(), como(res));

    expect((res.body as { data: { id: number; con_destinatarios: boolean }[] }).data.map((f) => [f.id, f.con_destinatarios])).toEqual([
      [92, true], [91, false], [90, true],
    ]);
    expect(entregasFindAll).toHaveBeenCalledTimes(1);
    expect(entregasFindAll.mock.calls[0][0]).toMatchObject({ where: { id_ejecucion: [92, 91, 90] }, attributes: ["id_ejecucion"], group: ["id_ejecucion"] });
  });

  it("keeps serving the history when the recipients table cannot be read: the runs are what matters, and they say so", async () => {
    contar.mockResolvedValue({ count: 2, rows: [fila(91), fila(90)] } as never);
    entregasFindAll.mockRejectedValue(new Error('relation "reporte_ejecucion_entregas" does not exist'));
    const res = respuesta();
    await getHistorialDeEjecuciones(peticion(), como(res));

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { id: number; con_destinatarios: boolean }[] }).data.map((f) => [f.id, f.con_destinatarios])).toEqual([
      [91, false], [90, false],
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
  });

  it("asks nothing about recipients when the page is empty", async () => {
    contar.mockResolvedValue({ count: 0, rows: [] } as never);
    await getHistorialDeEjecuciones(peticion(), como(respuesta()));
    expect(entregasFindAll).not.toHaveBeenCalled();
  });
});
