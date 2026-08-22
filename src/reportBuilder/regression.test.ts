// Regression against the hand-written reports.
//
// The builder is only trustworthy if it returns the SAME numbers as the reports
// the client already uses. These run against the local database and are skipped
// automatically when it is unreachable, so the unit suite still runs anywhere.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueryTypes } from "sequelize";
import type { Request, Response } from "express";
import {
  putEstadoRed,
  putObsFrecuencia,
  putTiemposResumen,
} from "../controllers/reporte.controller.js";
import { sequelize } from "../database/sequelize.js";
import { runReport } from "./execute.js";
import type { ReportConfig } from "./types.js";
import type { Viewer } from "./viewer.js";

const FROM = "2000-01-01";
const TO = "2030-12-31";
const ADMIN: Viewer = { role: 1, staff: true };

// Resolved before the suite is registered so the tests report as SKIPPED rather
// than passing vacuously when Postgres is unreachable — a green tick that
// asserts nothing is worse than a red one.
const dbAvailable = await sequelize
  .authenticate()
  .then(() => true)
  .catch(() => false);

beforeAll(() => {
  if (!dbAvailable) {
    console.warn("[regression] base de datos no disponible: pruebas omitidas");
  }
});

afterAll(async () => {
  if (dbAvailable) await sequelize.close();
});

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function fakeReq(body: unknown): Request {
  return { body, user: { id: 1, id_rol: ADMIN }, params: {} } as unknown as Request;
}

async function callLegacy(
  handler: (req: Request, res: Response) => Promise<unknown>,
  body: unknown,
): Promise<Record<string, unknown>[]> {
  const res = {
    code: 0,
    data: undefined as unknown,
    status(c: number) { res.code = c; return res; },
    json(d: unknown) { res.data = d; return res; },
  };
  await handler(fakeReq(body), res as unknown as Response);
  if (res.code !== 200) throw new Error(`legacy respondió ${res.code}`);
  return res.data as Record<string, unknown>[];
}

/** Multiset comparison: tramo labels are not unique, so position means nothing. */
function multisetDiff(a: string[], b: string[]): string[] {
  const count = (arr: string[]) =>
    arr.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>());
  const [ca, cb] = [count(a), count(b)];
  const out: string[] = [];
  for (const [v, n] of ca) if ((cb.get(v) ?? 0) !== n) out.push(`builder: ${v} x${n}`);
  for (const [v, n] of cb) if ((ca.get(v) ?? 0) !== n) out.push(`legacy:  ${v} x${n}`);
  return out;
}

/** "Events with at least one revision in the range" — what every report means by activity. */
const revisionEnRango = {
  exists: "revisiones",
  where: {
    op: "and" as const,
    conditions: [{ path: "date", operator: "between" as const, value: [FROM, TO] }],
  },
};

describe.skipIf(!dbAvailable)("regression against the existing reports", () => {
  it("estado de la red: postes, eventos and pending per tramo", async () => {

    const legacy = await callLegacy(putEstadoRed, {});
    const config: ReportConfig = {
      root: "poste",
      columns: [
        { path: "tramo" },
        { path: "id", agg: "count" },
        { path: "numEventos", agg: "sum" },
        { path: "numPendientes", agg: "sum" },
      ],
      groupBy: ["tramo"],
      limit: 5000,
    };
    const built = await runReport(config, ADMIN);

    const key = (o: Record<string, unknown>) =>
      `${o.tramo}|${o.postes}|${o.eventos}|${o.pendientes}`;
    const legacyRows = legacy
      .map((r) => ({
        tramo: `${r.ciudadAName} - ${r.ciudadBName}`,
        postes: num(r.totalPostes),
        eventos: num(r.totalEventos),
        pendientes: num(r.totalPendientes),
      }))
      .map(key);
    const builtRows = built.rows
      .map((r) => ({
        tramo: String(r.c0), postes: num(r.c1), eventos: num(r.c2), pendientes: num(r.c3),
      }))
      .map(key);

    expect(builtRows).toHaveLength(legacyRows.length);
    expect(multisetDiff(builtRows, legacyRows)).toEqual([]);
  });

  it("observaciones frecuentes: count per observation", async () => {

    const legacy = await callLegacy(putObsFrecuencia, { fechaInicial: FROM, fechaFinal: TO });
    const config: ReportConfig = {
      root: "eventoObs",
      columns: [{ path: "ob.name" }, { path: "id", agg: "count" }],
      groupBy: ["ob.name"],
      filters: {
        op: "and",
        conditions: [{ ...revisionEnRango, exists: "evento.revisiones" }],
      },
      limit: 5000,
    };
    const built = await runReport(config, ADMIN);

    // putObsFrecuencia filters by id_evento without checking the event is live,
    // so it also counts observations of archived events. The builder excludes
    // them on purpose; discount them to compare like with like.
    const archivedRows = (await sequelize.query(
      `SELECT o."name" AS name, COUNT(*)::int AS n
       FROM "eventoObs" eo
       JOIN eventos e ON e.id = eo."id_evento"
       JOIN obs o ON o.id = eo."id_obs"
       WHERE eo."deletedAt" IS NULL AND e."deletedAt" IS NOT NULL
       GROUP BY o."name"`,
      { type: QueryTypes.SELECT },
    )) as { name: string; n: number }[];
    const archived = new Map(archivedRows.map((r) => [r.name, Number(r.n)]));

    const expected = new Map(
      legacy.map((r) => [String(r.obs), num(r.count) - (archived.get(String(r.obs)) ?? 0)]),
    );

    expect(built.rows).toHaveLength(expected.size);
    for (const row of built.rows) {
      expect(num(row.c1), `observación "${row.c0}"`).toBe(expected.get(String(row.c0)));
    }
  });

  it("tiempos de resolución: count, average, min and max per tramo", async () => {

    const legacy = await callLegacy(putTiemposResumen, { fechaInicial: FROM, fechaFinal: TO });
    const config: ReportConfig = {
      root: "evento",
      columns: [
        { path: "poste.tramo" },
        { path: "id", agg: "count" },
        { path: "tiempoResolucion", agg: "avg" },
        { path: "tiempoResolucion", agg: "min" },
        { path: "tiempoResolucion", agg: "max" },
      ],
      groupBy: ["poste.tramo"],
      filters: {
        op: "and",
        conditions: [{ path: "state", operator: "eq", value: true }, revisionEnRango],
      },
      limit: 5000,
    };
    const built = await runReport(config, ADMIN);

    const key = (o: Record<string, unknown>) =>
      `${o.tramo}|${o.count}|${o.avg}|${o.min}|${o.max}`;
    const legacyRows = legacy
      .map((r) => ({
        tramo: `${r.ciudadAName} - ${r.ciudadBName}`,
        count: num(r.count), avg: num(r.avgDias), min: num(r.minDias), max: num(r.maxDias),
      }))
      .map(key);
    const builtRows = built.rows
      .map((r) => ({
        tramo: String(r.c0), count: num(r.c1), avg: Math.round(num(r.c2)),
        min: num(r.c3), max: num(r.c4),
      }))
      .map(key);

    expect(builtRows).toHaveLength(legacyRows.length);
    expect(multisetDiff(builtRows, legacyRows)).toEqual([]);
  });
});
