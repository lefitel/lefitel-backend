// The history of every schedule, down to the SQL Sequelize builds from the
// handler's real options.
//
// `programacion.controller.test.ts` asserts the options object that reaches
// `findAndCountAll`, which is a mock there. That cannot see a `subQuery`,
// a `separate`, a `distinct` or a renamed association alias that would make
// the real statements differ from what the options promise — and the owner's
// condition on the join is the whole of who may read whose runs. Here the
// model is real and only `sequelize.query` is stubbed, so the two statements
// `findAndCountAll` issues (the count, then the rows) are the ones asserted.
// No database is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const can = vi.fn(async (_rol: number, _modulo: string, _accion: string) => false);
vi.mock("../permissions/store.js", () => ({ can: (...a: [number, string, string]) => can(...a) }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock("../reportSchedule/run.js", () => ({ ejecutarTurno: vi.fn() }));
vi.mock("../reportSchedule/runtime.js", () => ({ dependenciasDeInformes: () => ({}) }));

const { sequelize } = await import("../database/sequelize.js");
const { ReporteEjecucionModel } = await import("../models/reporteProgramacion.model.js");
const { getDestinatariosDeEjecucion, getHistorialDeEjecuciones } = await import("./programacion.controller.js");

const YO = 7;
const sentencias: string[] = [];

beforeEach(() => {
  sentencias.length = 0;
  can.mockReset();
  can.mockResolvedValue(false);
  vi.spyOn(sequelize, "query").mockImplementation((async (consulta: unknown) => {
    const sql = typeof consulta === "string" ? consulta : (consulta as { query: string }).query;
    sentencias.push(sql);
    // A SELECT answers its rows; the count answers one row holding the number.
    return /count\(/i.test(sql) ? [{ count: "0" }] : [];
  }) as never);
});

async function pedir(query: Record<string, string> = {}) {
  const res = { statusCode: 0, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
    status(c: number): typeof res;
    json(b: unknown): typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  await getHistorialDeEjecuciones({ query, user: { id: YO, id_rol: 2 } } as unknown as Request, res as unknown as Response);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const cuenta = sentencias.find((s) => /count\(/i.test(s));
  const filas = sentencias.find((s) => /ORDER BY/i.test(s));
  expect(cuenta, "the count statement").toBeDefined();
  expect(filas, "the rows statement").toBeDefined();
  return { cuenta: cuenta!, filas: filas! };
}

const UNION = /INNER JOIN "reporte_programaciones" AS "reporteProgramacion" ON [^;]*?(?= WHERE| ORDER BY|;)/;

describe("the SQL of the history of every schedule", () => {
  it("joins the schedule as an inner join that carries the owner's condition, in the count and in the rows", async () => {
    const { cuenta, filas } = await pedir();
    for (const sql of [cuenta, filas]) {
      const union = UNION.exec(sql)?.[0] ?? "";
      expect(union, sql).toContain(`"reporteEjecucion"."id_programacion" = "reporteProgramacion"."id"`);
      expect(union, sql).toContain(`"reporteProgramacion"."id_usuario" = ${YO}`);
    }
  });

  it("does not narrow a moderator: the same join, with no owner condition", async () => {
    can.mockImplementation(async (_rol, modulo, accion) => modulo === "seguridad" && accion === "editar");
    const { cuenta, filas } = await pedir();
    for (const sql of [cuenta, filas]) {
      const union = UNION.exec(sql)?.[0] ?? "";
      expect(union, sql).toContain("INNER JOIN");
      expect(sql).not.toContain(`"reporteProgramacion"."id_usuario" =`);
    }
  });

  it("does not hide a deleted schedule's runs: nothing asks for deleted_at to be empty", async () => {
    const { cuenta, filas } = await pedir();
    for (const sql of [cuenta, filas]) expect(sql).not.toMatch(/deleted_at"? IS NULL/i);
  });

  it("puts both filters in the WHERE of both statements, and a foreign id does not remove the owner condition", async () => {
    const { cuenta, filas } = await pedir({ estado: "fallido", id_programacion: "99" });
    for (const sql of [cuenta, filas]) {
      const donde = sql.slice(sql.indexOf(" WHERE "));
      expect(donde, sql).toContain(`"reporteEjecucion"."estado" = 'fallido'`);
      expect(donde, sql).toContain(`"reporteEjecucion"."id_programacion" = 99`);
      expect(UNION.exec(sql)?.[0], sql).toContain(`"reporteProgramacion"."id_usuario" = ${YO}`);
    }
  });

  it("orders the rows newest first and by id within it, and pages them", async () => {
    const { filas } = await pedir({ page: "3", limit: "10" });
    expect(filas).toMatch(/ORDER BY "reporteEjecucion"\."programada_para" DESC, "reporteEjecucion"\."id" DESC/);
    expect(filas).toMatch(/LIMIT 10 OFFSET 20/);
  });

  it("counts the runs by their own key, over the same join", async () => {
    const { cuenta } = await pedir();
    expect(cuenta).toMatch(/count\("reporteEjecucion"\."id"\)/i);
  });
});

describe("the SQL of the recipients of one run", () => {
  /**
   * The first read (the run and its schedule) is answered with the instance it
   * would build: a stubbed `query` hands back whatever it is given, and the model
   * only grows an instance out of rows the driver has already shaped. Its own
   * options are `programacion.controller.test.ts`'s; what is checked here is the
   * SQL of the two statements that serve the recipients.
   */
  const conDueno = (idUsuario: number) =>
    vi.spyOn(ReporteEjecucionModel, "findByPk").mockResolvedValue({
      dataValues: { id: 90, reporteProgramacion: { dataValues: { id: 5, id_usuario: idUsuario } } },
    } as never);

  async function pedirDestinatarios() {
    const res = { statusCode: 0, body: undefined as unknown } as {
      statusCode: number; body: unknown; status(c: number): typeof res; json(b: unknown): typeof res;
    };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    await getDestinatariosDeEjecucion(
      { query: {}, params: { id: "90" }, user: { id: YO, id_rol: 2 } } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const cuenta = sentencias.find((s) => /count\(/i.test(s) && /reporte_ejecucion_entregas/.test(s));
    const filas = sentencias.find((s) => /FROM "reporte_ejecucion_entregas"/.test(s) && !/count\(/i.test(s));
    expect(cuenta, "the count statement").toBeDefined();
    expect(filas, "the rows statement").toBeDefined();
    return { cuenta: cuenta!, filas: filas! };
  }

  it("carries the owner's condition through the run to its schedule, in the count and in the rows", async () => {
    conDueno(YO);
    const { cuenta, filas } = await pedirDestinatarios();
    for (const sql of [cuenta, filas]) {
      expect(sql, sql).toMatch(/INNER JOIN "reporte_ejecuciones" AS "reporteEjecucion" ON "reporteEntrega"\."id_ejecucion" = "reporteEjecucion"\."id"/);
      expect(sql, sql).toMatch(/INNER JOIN "reporte_programaciones" AS "reporteEjecucion->reporteProgramacion" ON [^;]*"reporteEjecucion->reporteProgramacion"\."id_usuario" = 7/);
      expect(sql).toContain(`"reporteEntrega"."id_ejecucion" = 90`);
      expect(sql).not.toMatch(/deleted_at"? IS NULL/i);
    }
    expect(filas).toMatch(/ORDER BY "reporteEntrega"\."id" ASC/);
  });

  it("does not narrow a moderator reading somebody else's", async () => {
    can.mockImplementation(async (_rol, modulo, accion) => modulo === "seguridad" && accion === "editar");
    conDueno(8);
    const { cuenta, filas } = await pedirDestinatarios();
    for (const sql of [cuenta, filas]) {
      expect(sql, sql).toContain("INNER JOIN");
      // No leading quote: under this query's alias the column is
      // `"reporteEjecucion->reporteProgramacion"."id_usuario"`, which a pattern
      // opening with `"reporteProgramacion"` can never match.
      expect(sql).not.toMatch(/reporteProgramacion"\."id_usuario" = /);
    }
  });

  it("selects nothing of the account behind a recipient: the row has no such column to read", async () => {
    conDueno(YO);
    const { filas } = await pedirDestinatarios();
    expect(filas).not.toMatch(/email|"usuarios"/i);
  });
});
