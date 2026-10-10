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
vi.mock("../utils/logger.js", () => ({ log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

const ejecutarTurno = vi.fn();
vi.mock("../reportSchedule/run.js", () => ({ ejecutarTurno: (...a: unknown[]) => ejecutarTurno(...a) }));
vi.mock("../reportSchedule/runtime.js", () => ({ dependenciasDeInformes: () => ({ falsas: true }) }));

const { sequelize } = await import("../database/sequelize.js");
vi.spyOn(sequelize, "transaction").mockImplementation((async (cb: (t: unknown) => Promise<unknown>) => cb({ id: "t" })) as never);

const { ReporteProgramacionModel, ReporteProgramacionDestinatarioModel, ReporteEjecucionModel } = await import(
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
const informeFindByPk = vi.spyOn(ReporteVistaModel, "findByPk");
const informeFindAll = vi.spyOn(ReporteVistaModel, "findAll");
const usuarioCount = vi.spyOn(UsuarioModel, "count");
const usuarioFindAll = vi.spyOn(UsuarioModel, "findAll");

const {
  deleteProgramacion,
  getEjecucionesDeProgramacion,
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
