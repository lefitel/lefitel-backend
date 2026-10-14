import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { Op } from "sequelize";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { RevisionModel, REVISION_PUBLIC_ATTRIBUTES } from "../models/revision.model.js";
import { PosteModel, POSTE_PUBLIC_ATTRIBUTES } from "../models/poste.model.js";
import { SolucionModel, SOLUCION_PUBLIC_ATTRIBUTES } from "../models/solucion.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { MaterialModel } from "../models/material.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { ObsModel } from "../models/obs.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { IEvento, IEventoObs, IObs, IPoste, ITipoObs } from "../interfaces/index.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerFiltro, leerFiltroSinRango } from "./reporteFiltro.js";
import { INCLUDE_TRAMO, presentarTramo, presentarTramos, type TramoPresentado } from "../tramos/presentacion.js";

const reporteLog = log("reporte");
const handler = makeHandler(reporteLog);

// ─── Tipos para datos con asociaciones (resultado de toJSON) ──────────────────

interface IPosteConEventos extends IPoste {
  id_tramo: number;
  tramo: unknown;
  eventos: Pick<IEvento, "id" | "state">[];
}

interface IEventoObsConOb extends IEventoObs {
  ob: (Pick<IObs, "id" | "name" | "criticality"> & {
    tipoObs: Pick<ITipoObs, "id" | "name"> | null;
  }) | null;
}

interface IEventoConSolucion extends IEvento {
  solucions: { date: Date }[];
  revisions: { id: number }[];
  poste: (Pick<IPoste, "id"> & { id_tramo: number; tramo: unknown }) | null;
}

// IDs de eventos que tienen al menos una revisión dentro del rango de fechas
const getEventIdsInRange = async (fechaInicial: Date, fechaFinal: Date): Promise<number[]> => {
  const rows = await RevisionModel.findAll({
    where: { date: { [Op.between]: [fechaInicial, fechaFinal] } },
    attributes: ["id_evento"],
    group: ["id_evento"],
  });
  return rows.map((r) => r.dataValues.id_evento as number);
};

// IDs de eventos REPARADOS dentro del rango. Hermana de `getEventIdsInRange`,
// que selecciona por fecha de revisión: para "cuánto tardamos en reparar", la
// pregunta es qué se reparó en el período, no qué se fue a mirar. Los demás
// informes siguen usando la de revisiones a propósito.
const getEventIdsRepairedInRange = async (fechaInicial: Date, fechaFinal: Date): Promise<number[]> => {
  const rows = await SolucionModel.findAll({
    where: { date: { [Op.between]: [fechaInicial, fechaFinal] } },
    attributes: ["id_evento"],
    group: ["id_evento"],
  });
  return rows.map((r) => r.dataValues.id_evento as number);
};

/**
 * The pole filter of the reports that only narrow by tramo when one is named.
 * Empty when none is, so that the query is the one it always was. `required`
 * is what turns the include into an inner join: without it the filter narrows
 * nothing, since every incident would come back with a null pole.
 */
const soloDelTramo = (tramo: number | null) =>
  tramo === null ? {} : { required: true, where: { id_tramo: tramo } };

export const getReporteGeneral = handler("getReporteGeneral", async (req: Request, res: Response) => {
  const filtro = leerFiltro(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });
  const { fechaInicial: fi, fechaFinal: ff, excludeOld } = filtro;

  const eventIds = await getEventIdsInRange(fi, ff);
  const eventoWhere: Record<string, unknown> = { id: { [Op.in]: eventIds } };
  if (excludeOld) eventoWhere.date = { [Op.between]: [fi, ff] };
  const data = await EventoModel.findAll({
    where: eventoWhere,
    order: [["id", "DESC"]],
    include: [
      {
        model: PosteModel,
        attributes: [...POSTE_PUBLIC_ATTRIBUTES],
        ...soloDelTramo(filtro.tramo),
        include: [
          { model: MaterialModel },
          { model: PropietarioModel },
          INCLUDE_TRAMO,
        ],
      },
      { model: SolucionModel, attributes: [...SOLUCION_PUBLIC_ATTRIBUTES] },
      { model: RevisionModel, attributes: [...REVISION_PUBLIC_ATTRIBUTES] },
      {
        model: EventoObsModel,
        attributes: ["id", "id_obs"],
        include: [{ model: ObsModel, as: "ob", attributes: ["id", "name", "criticality"] }],
      },
    ],
  });
  res.status(200).json(presentarTramos(data));
});

export const getReporteTramo = handler("getReporteTramo", async (req: Request, res: Response) => {
  const filtro = leerFiltro(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });
  const { fechaInicial: fi, fechaFinal: ff, excludeOld } = filtro;

  const posteWhere = filtro.tramo !== null ? { id_tramo: filtro.tramo } : undefined;

  const eventIds = await getEventIdsInRange(fi, ff);
  const eventoWhere: Record<string, unknown> = { id: { [Op.in]: eventIds } };
  if (excludeOld) eventoWhere.date = { [Op.between]: [fi, ff] };
  const data = await EventoModel.findAll({
    where: eventoWhere,
    order: [["id", "DESC"]],
    include: [
      { model: EventoObsModel },
      {
        model: PosteModel,
        attributes: [...POSTE_PUBLIC_ATTRIBUTES],
        required: !!posteWhere,
        ...(posteWhere ? { where: posteWhere } : {}),
        include: [
          { model: MaterialModel },
          { model: AdssPosteModel },
          { model: PropietarioModel },
          INCLUDE_TRAMO,
        ],
      },
      { model: SolucionModel, attributes: [...SOLUCION_PUBLIC_ATTRIBUTES] },
      { model: RevisionModel, attributes: [...REVISION_PUBLIC_ATTRIBUTES] },
    ],
  });
  res.status(200).json(presentarTramos(data));
});

export const getReporteRecorrido = handler("getReporteRecorrido", async (req: Request, res: Response) => {
  // The one report that cannot answer anything without a stretch: it draws the
  // line of one tramo.
  const filtro = leerFiltro(req.query, { tramo: "obligatorio" });
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });
  const { fechaInicial: fi, fechaFinal: ff, excludeOld } = filtro;

  const eventIds = await getEventIdsInRange(fi, ff);
  const eventoWhere: Record<string, unknown> = { id: { [Op.in]: eventIds } };
  if (excludeOld) eventoWhere.date = { [Op.between]: [fi, ff] };
  const data = await EventoModel.findAll({
    where: eventoWhere,
    order: [["id", "DESC"]],
    include: [
      {
        model: PosteModel,
        attributes: [...POSTE_PUBLIC_ATTRIBUTES],
        required: true,
        where: { id_tramo: filtro.tramo },
        include: [
          { model: MaterialModel },
          { model: PropietarioModel },
          INCLUDE_TRAMO,
        ],
      },
      { model: SolucionModel, attributes: [...SOLUCION_PUBLIC_ATTRIBUTES] },
      { model: RevisionModel, attributes: [...REVISION_PUBLIC_ATTRIBUTES] },
      {
        model: EventoObsModel,
        attributes: ["id", "id_obs"],
        include: [{ model: ObsModel, as: "ob", attributes: ["id", "name", "criticality"] }],
      },
    ],
  });
  res.status(200).json(presentarTramos(data));
});

// ─── Estado de la Red ─────────────────────────────────────────────────────────
// Agrupa postes por tramo y cuenta eventos pendientes.
// Si se proveen fechas, solo cuenta eventos con revisión en ese rango.

export const getEstadoRed = handler("getEstadoRed", async (req: Request, res: Response) => {
  // The only one of the six that answers over the whole history when given no
  // period, which is why it reads the filter with its own function.
  const filtro = leerFiltroSinRango(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });

  let eventWhere: { id: { [key: symbol]: number[] } } | undefined;
  if (filtro.fechaInicial && filtro.fechaFinal) {
    const eventIds = await getEventIdsInRange(filtro.fechaInicial, filtro.fechaFinal);
    eventWhere = { id: { [Op.in]: eventIds } };
  }

  const postes = await PosteModel.findAll({
    ...(filtro.tramo !== null ? { where: { id_tramo: filtro.tramo } } : {}),
    attributes: ["id", "id_tramo"],
    include: [
      INCLUDE_TRAMO,
      {
        model: EventoModel,
        attributes: ["id", "state"],
        required: false,
        ...(eventWhere ? { where: eventWhere } : {}),
      },
    ],
  });

  const tramoMap = new Map<number, {
    tramo: TramoPresentado;
    totalPostes: number; conPendientes: number;
    totalPendientes: number; totalEventos: number;
  }>();

  for (const p of postes) {
    const pd = p.toJSON() as unknown as IPosteConEventos;
    // Cannot happen (`id_tramo` is NOT NULL and the include is `paranoid: false`);
    // if it ever does, the pole is left out rather than failing the whole report.
    if (!pd.tramo) continue;
    if (!tramoMap.has(pd.id_tramo)) {
      tramoMap.set(pd.id_tramo, {
        tramo: presentarTramo(pd.tramo),
        totalPostes: 0, conPendientes: 0, totalPendientes: 0, totalEventos: 0,
      });
    }
    const row = tramoMap.get(pd.id_tramo)!;
    const eventos = pd.eventos ?? [];
    row.totalPostes++;
    const pending = eventos.filter((e) => !e.state).length;
    if (pending > 0) row.conPendientes++;
    row.totalPendientes += pending;
    row.totalEventos += eventos.length;
  }

  // pctSalud = eventos resueltos / total eventos (más preciso que contar postes)
  const result = [...tramoMap.values()]
    .map((row) => ({
      ...row,
      pctSalud: row.totalEventos > 0
        ? Math.round(((row.totalEventos - row.totalPendientes) / row.totalEventos) * 100)
        : 100,
    }))
    .sort((a, b) => a.pctSalud - b.pctSalud);

  res.status(200).json(result);
});

// ─── Observaciones Frecuentes ─────────────────────────────────────────────────
// Cuenta cuántas veces aparece cada observación en los eventos del período.

export const getObsFrecuencia = handler("getObsFrecuencia", async (req: Request, res: Response) => {
  const filtro = leerFiltro(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });

  const eventIds = await getEventIdsInRange(filtro.fechaInicial, filtro.fechaFinal);
  const rows = await EventoObsModel.findAll({
    where: { id_evento: { [Op.in]: eventIds } },
    attributes: ["id_obs"],
    include: [
      {
        model: ObsModel,
        attributes: ["id", "name", "criticality"],
        include: [{ model: TipoObsModel, as: "tipoObs", attributes: ["id", "name"] }],
      },
      // Only to restrict: no column of the incident or the pole is read, and an
      // inner join on a tramo's poles drops the observations of the rest.
      ...(filtro.tramo !== null
        ? [{
            model: EventoModel,
            attributes: [],
            required: true,
            include: [{ model: PosteModel, attributes: [], ...soloDelTramo(filtro.tramo) }],
          }]
        : []),
    ],
  });

  const map = new Map<number, { tipoObs: string; obs: string; criticality: number | null; count: number }>();
  for (const r of rows) {
    const rd = r.toJSON() as unknown as IEventoObsConOb;
    if (!rd.ob) continue;
    const curr = map.get(rd.id_obs) ?? {
      tipoObs: rd.ob.tipoObs?.name ?? "—",
      obs: rd.ob.name,
      criticality: rd.ob.criticality ?? null,
      count: 0,
    };
    curr.count++;
    map.set(rd.id_obs, curr);
  }

  const total = [...map.values()].reduce((s, r) => s + r.count, 0);
  const result = [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ ...r, pct: total > 0 ? Math.round((r.count / total) * 100) : 0 }));

  res.status(200).json(result);
});

// ─── Tiempos de Reparación (resumen por tramo) ────────────────────────────────
// Para los eventos reparados en el período, calcula avg/min/max días por tramo.
//
// El intervalo va de `evento.date` — el día en que ocurrió la avería — hasta la
// fecha de su solución, que es la reparación. Antes iba del alta en el sistema
// hasta la ÚLTIMA revisión, que es una visita de inspección y no cierra nada:
// medía el tiempo hasta que alguien fue a mirar y lo llamaba resolución. Sobre
// la base real eso daba una mediana de 9 días donde la verdadera es 44.
//
// Los eventos incoherentes —reparación fechada antes que la avería, cosa que el
// histórico contiene— se DESCARTAN y se informa cuántos. Antes se forzaban a 0
// con un Math.max, que es como un tercio de los eventos acababa publicándose
// como resuelto el mismo día.

export const getTiemposResumen = handler("getTiemposResumen", async (req: Request, res: Response) => {
  const filtro = leerFiltro(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });

  const eventIds = await getEventIdsRepairedInRange(filtro.fechaInicial, filtro.fechaFinal);
  const eventos = await EventoModel.findAll({
    where: { id: { [Op.in]: eventIds }, state: true },
    attributes: ["id", "date"],
    include: [
      {
        model: SolucionModel,
        attributes: ["date"],
      },
      // Sólo para contarlas: cuántas visitas costó cerrar el evento.
      {
        model: RevisionModel,
        attributes: ["id"],
      },
      {
        model: PosteModel,
        attributes: ["id", "id_tramo"],
        ...soloDelTramo(filtro.tramo),
        include: [INCLUDE_TRAMO],
      },
    ],
  });

  const tramoMap = new Map<number, { tramo: TramoPresentado; dias: number[]; visitas: number[] }>();

  let descartados = 0;

  for (const e of eventos) {
    const ed = e.toJSON() as unknown as IEventoConSolucion;
    const p = ed.poste;
    // A pole without its tramo cannot happen (`id_tramo` is NOT NULL and the
    // include is `paranoid: false`); if it ever does, the evento is left out
    // rather than failing the whole report.
    if (!p || !p.tramo || !ed.date) continue;

    // Fecha de reparación = fecha de la solución. Sin solución no hay nada que
    // medir: el evento no llegó a cerrarse.
    const solucions = ed.solucions ?? [];
    if (solucions.length === 0) continue;
    const fechaReparacion = new Date(Math.max(...solucions.map((s) => new Date(s.date).getTime())));

    // Reparado antes de ocurrir: el dato no se sostiene, así que no promedia.
    // Se cuenta aparte para poder decir en pantalla cuántos quedaron fuera.
    //
    // La comparación va sobre los instantes, NO sobre los días redondeados.
    // Una reparación a las 09:00 de una avería de las 14:00 del mismo día
    // redondea a -0, y `-0 < 0` es falso en JavaScript, así que colaba como
    // "reparado en 0 días" — que es justo el cero fantasma que se quitó.
    const inicio = new Date(ed.date).getTime();
    const fin = fechaReparacion.getTime();
    if (!Number.isFinite(inicio) || !Number.isFinite(fin) || fin < inicio) {
      descartados++;
      continue;
    }
    const dias = Math.round((fin - inicio) / (1000 * 60 * 60 * 24));

    if (!tramoMap.has(p.id_tramo)) {
      tramoMap.set(p.id_tramo, { tramo: presentarTramo(p.tramo), dias: [], visitas: [] });
    }
    tramoMap.get(p.id_tramo)!.dias.push(dias);
    tramoMap.get(p.id_tramo)!.visitas.push((ed.revisions ?? []).length);
  }

  const result = [...tramoMap.values()]
    .filter((t) => t.dias.length > 0)
    .map((t) => ({
      tramo: t.tramo,
      count: t.dias.length,
      avgVisitas: Math.round((t.visitas.reduce((s, v) => s + v, 0) / t.visitas.length) * 10) / 10,
      avgDias: Math.round(t.dias.reduce((s, d) => s + d, 0) / t.dias.length),
      minDias: Math.min(...t.dias),
      maxDias: Math.max(...t.dias),
    }))
    .sort((a, b) => b.avgDias - a.avgDias);

  res.status(200).json({ tramos: result, descartados });
});
