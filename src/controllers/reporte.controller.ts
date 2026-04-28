import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { Op } from "sequelize";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { RevicionModel } from "../models/revicion.model.js";
import { PosteModel } from "../models/poste.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { MaterialModel } from "../models/material.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { ObsModel } from "../models/obs.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { ICiudad, IEvento, IEventoObs, IObs, IPoste, IRevicion, ITipoObs } from "../interfaces/index.js";

// ─── Tipos para datos con asociaciones (resultado de toJSON) ──────────────────

interface IPosteConEventos extends IPoste {
  ciudadA: Pick<ICiudad, "id" | "name"> | null;
  ciudadB: Pick<ICiudad, "id" | "name"> | null;
  eventos: Pick<IEvento, "id" | "state">[];
}

interface IEventoObsConOb extends IEventoObs {
  ob: (Pick<IObs, "id" | "name"> & {
    tipoObs: Pick<ITipoObs, "id" | "name"> | null;
  }) | null;
}

interface IEventoConReviciones extends IEvento {
  createdAt: Date;
  revicions: Pick<IRevicion, "date">[];
  poste: (Pick<IPoste, "id" | "id_ciudadA" | "id_ciudadB"> & {
    ciudadA: Pick<ICiudad, "id" | "name"> | null;
    ciudadB: Pick<ICiudad, "id" | "name"> | null;
  }) | null;
}

// IDs de eventos que tienen al menos una revisión dentro del rango de fechas
const getEventIdsInRange = async (fechaInicial: Date, fechaFinal: Date): Promise<number[]> => {
  const rows = await RevicionModel.findAll({
    where: { date: { [Op.between]: [fechaInicial, fechaFinal] } },
    attributes: ["id_evento"],
    group: ["id_evento"],
  });
  return rows.map((r) => r.dataValues.id_evento as number);
};

export async function putReporteGeneral(req: Request, res: Response) {
  const { fechaInicial, fechaFinal, excludeOld } = req.body;
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const fi = new Date(fechaInicial);
    const ff = new Date(fechaFinal);
    const eventIds = await getEventIdsInRange(fi, ff);
    const eventoWhere: Record<string, unknown> = { id: { [Op.in]: eventIds } };
    if (excludeOld) eventoWhere.date = { [Op.between]: [fi, ff] };
    const data = await EventoModel.findAll({
      where: eventoWhere,
      order: [["id", "DESC"]],
      include: [
        {
          model: PosteModel,
          include: [
            { model: MaterialModel },
            { model: PropietarioModel },
            { model: CiudadModel, as: "ciudadA" },
            { model: CiudadModel, as: "ciudadB" },
          ],
        },
        { model: SolucionModel },
        { model: RevicionModel },
      ],
    });
    res.status(200).json(data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}

export async function putReporteTramo(req: Request, res: Response) {
  const { fechaInicial, fechaFinal, TramoInicial, TramoFinal, excludeOld } = req.body;
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }

  const posteWhere = (TramoInicial && TramoFinal)
    ? {
        [Op.or]: [
          { id_ciudadA: TramoInicial, id_ciudadB: TramoFinal },
          { id_ciudadA: TramoFinal,   id_ciudadB: TramoInicial },
        ],
      }
    : undefined;

  try {
    const fi = new Date(fechaInicial);
    const ff = new Date(fechaFinal);
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
          required: !!posteWhere,
          ...(posteWhere ? { where: posteWhere } : {}),
          include: [
            { model: MaterialModel },
            { model: AdssPosteModel },
            { model: PropietarioModel },
            { model: CiudadModel, as: "ciudadA" },
            { model: CiudadModel, as: "ciudadB" },
          ],
        },
        { model: SolucionModel },
        { model: RevicionModel },
      ],
    });
    res.status(200).json(data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}

export async function putReporteRecorrido(req: Request, res: Response) {
  const { TramoInicial, TramoFinal, fechaInicial, fechaFinal, excludeOld } = req.body;
  if (!TramoInicial || !TramoFinal) {
    return res.status(400).json({ message: "TramoInicial y TramoFinal son requeridos" });
  }
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const fi = new Date(fechaInicial);
    const ff = new Date(fechaFinal);
    const eventIds = await getEventIdsInRange(fi, ff);
    const eventoWhere: Record<string, unknown> = { id: { [Op.in]: eventIds } };
    if (excludeOld) eventoWhere.date = { [Op.between]: [fi, ff] };
    const data = await EventoModel.findAll({
      where: eventoWhere,
      order: [["id", "DESC"]],
      include: [
        {
          model: PosteModel,
          required: true,
          where: {
            [Op.or]: [
              { id_ciudadA: TramoInicial, id_ciudadB: TramoFinal },
              { id_ciudadA: TramoFinal,   id_ciudadB: TramoInicial },
            ],
          },
          include: [
            { model: MaterialModel },
            { model: PropietarioModel },
            { model: CiudadModel, as: "ciudadA" },
            { model: CiudadModel, as: "ciudadB" },
          ],
        },
        { model: SolucionModel },
        { model: RevicionModel },
      ],
    });
    res.status(200).json(data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}

// ─── Estado de la Red ─────────────────────────────────────────────────────────
// Agrupa postes por tramo y cuenta eventos pendientes.
// Si se proveen fechas, solo cuenta eventos con revisión en ese rango.

export async function putEstadoRed(req: Request, res: Response) {
  const { fechaInicial, fechaFinal } = req.body;
  try {
    let eventWhere: { id: { [key: symbol]: number[] } } | undefined;
    if (fechaInicial && fechaFinal) {
      const eventIds = await getEventIdsInRange(new Date(fechaInicial), new Date(fechaFinal));
      eventWhere = { id: { [Op.in]: eventIds } };
    }

    const postes = await PosteModel.findAll({
      attributes: ["id", "id_ciudadA", "id_ciudadB"],
      include: [
        { model: CiudadModel, as: "ciudadA", attributes: ["id", "name"] },
        { model: CiudadModel, as: "ciudadB", attributes: ["id", "name"] },
        {
          model: EventoModel,
          attributes: ["id", "state"],
          required: false,
          ...(eventWhere ? { where: eventWhere } : {}),
        },
      ],
    });

    const tramoMap = new Map<string, {
      ciudadAId: number; ciudadBId: number;
      ciudadAName: string; ciudadBName: string;
      totalPostes: number; conPendientes: number;
      totalPendientes: number; totalEventos: number;
    }>();

    for (const p of postes) {
      const pd = p.toJSON() as unknown as IPosteConEventos;
      const key = `${pd.id_ciudadA}-${pd.id_ciudadB}`;
      if (!tramoMap.has(key)) {
        tramoMap.set(key, {
          ciudadAId: pd.id_ciudadA,
          ciudadBId: pd.id_ciudadB,
          ciudadAName: pd.ciudadA?.name ?? `#${pd.id_ciudadA}`,
          ciudadBName: pd.ciudadB?.name ?? `#${pd.id_ciudadB}`,
          totalPostes: 0, conPendientes: 0,
          totalPendientes: 0, totalEventos: 0,
        });
      }
      const row = tramoMap.get(key)!;
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}

// ─── Observaciones Frecuentes ─────────────────────────────────────────────────
// Cuenta cuántas veces aparece cada observación en los eventos del período.

export async function putObsFrecuencia(req: Request, res: Response) {
  const { fechaInicial, fechaFinal } = req.body;
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const eventIds = await getEventIdsInRange(new Date(fechaInicial), new Date(fechaFinal));
    const rows = await EventoObsModel.findAll({
      where: { id_evento: { [Op.in]: eventIds } },
      attributes: ["id_obs"],
      include: [{
        model: ObsModel,
        attributes: ["id", "name"],
        include: [{ model: TipoObsModel, as: "tipoObs", attributes: ["id", "name"] }],
      }],
    });

    const map = new Map<number, { tipoObs: string; obs: string; count: number }>();
    for (const r of rows) {
      const rd = r.toJSON() as unknown as IEventoObsConOb;
      if (!rd.ob) continue;
      const curr = map.get(rd.id_obs) ?? {
        tipoObs: rd.ob.tipoObs?.name ?? "—",
        obs: rd.ob.name,
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}

// ─── Tiempos de Resolución (resumen por tramo) ────────────────────────────────
// Para eventos resueltos en el período, calcula avg/min/max días por tramo.
// Usa la fecha de la última revisión como fecha de resolución (más preciso que updatedAt).

export async function putTiemposResumen(req: Request, res: Response) {
  const { fechaInicial, fechaFinal } = req.body;
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const eventIds = await getEventIdsInRange(new Date(fechaInicial), new Date(fechaFinal));
    const eventos = await EventoModel.findAll({
      where: { id: { [Op.in]: eventIds }, state: true },
      attributes: ["id", "createdAt"],
      include: [
        {
          model: RevicionModel,
          attributes: ["date"],
        },
        {
          model: PosteModel,
          attributes: ["id", "id_ciudadA", "id_ciudadB"],
          include: [
            { model: CiudadModel, as: "ciudadA", attributes: ["id", "name"] },
            { model: CiudadModel, as: "ciudadB", attributes: ["id", "name"] },
          ],
        },
      ],
    });

    const tramoMap = new Map<string, {
      ciudadAId: number | null; ciudadBId: number | null;
      ciudadAName: string; ciudadBName: string; dias: number[];
    }>();

    for (const e of eventos) {
      const ed = e.toJSON() as unknown as IEventoConReviciones;
      const p = ed.poste;
      if (!p || !ed.createdAt) continue;

      // Fecha de resolución = fecha de la última revisión registrada
      const revicions = ed.revicions ?? [];
      if (revicions.length === 0) continue;
      const fechaResolucion = new Date(Math.max(...revicions.map((r) => new Date(r.date).getTime())));

      const key = `${p.id_ciudadA}-${p.id_ciudadB}`;
      if (!tramoMap.has(key)) {
        tramoMap.set(key, {
          ciudadAId: p.id_ciudadA ?? null,
          ciudadBId: p.id_ciudadB ?? null,
          ciudadAName: p.ciudadA?.name ?? `#${p.id_ciudadA}`,
          ciudadBName: p.ciudadB?.name ?? `#${p.id_ciudadB}`,
          dias: [],
        });
      }
      const dias = Math.round(
        (fechaResolucion.getTime() - new Date(ed.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      );
      tramoMap.get(key)!.dias.push(Math.max(0, dias));
    }

    const result = [...tramoMap.values()]
      .filter((t) => t.dias.length > 0)
      .map((t) => ({
        ciudadAId: t.ciudadAId,
        ciudadBId: t.ciudadBId,
        ciudadAName: t.ciudadAName,
        ciudadBName: t.ciudadBName,
        count: t.dias.length,
        avgDias: Math.round(t.dias.reduce((s, d) => s + d, 0) / t.dias.length),
        minDias: Math.min(...t.dias),
        maxDias: Math.max(...t.dias),
      }))
      .sort((a, b) => b.avgDias - a.avgDias);

    res.status(200).json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}
