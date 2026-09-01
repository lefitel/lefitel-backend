import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { Op } from "sequelize";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { RevisionModel, REVISION_PUBLIC_ATTRIBUTES } from "../models/revision.model.js";
import { PosteModel, POSTE_PUBLIC_ATTRIBUTES } from "../models/poste.model.js";
import { SolucionModel, SOLUCION_PUBLIC_ATTRIBUTES } from "../models/solucion.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { MaterialModel } from "../models/material.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { ObsModel } from "../models/obs.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { ICiudad, IEvento, IEventoObs, IObs, IPoste, IRevision, ITipoObs } from "../interfaces/index.js";

// ─── Tipos para datos con asociaciones (resultado de toJSON) ──────────────────

interface IPosteConEventos extends IPoste {
  ciudadA: Pick<ICiudad, "id" | "name"> | null;
  ciudadB: Pick<ICiudad, "id" | "name"> | null;
  eventos: Pick<IEvento, "id" | "state">[];
}

interface IEventoObsConOb extends IEventoObs {
  ob: (Pick<IObs, "id" | "name" | "criticality"> & {
    tipoObs: Pick<ITipoObs, "id" | "name"> | null;
  }) | null;
}

interface IEventoConRevisions extends IEvento {
  createdAt: Date;
  revisions: Pick<IRevision, "date">[];
  poste: (Pick<IPoste, "id" | "id_ciudadA" | "id_ciudadB"> & {
    ciudadA: Pick<ICiudad, "id" | "name"> | null;
    ciudadB: Pick<ICiudad, "id" | "name"> | null;
  }) | null;
}

interface IEventoConSolucion extends IEvento {
  solucions: { date: Date }[];
  revisions: { id: number }[];
  poste: (Pick<IPoste, "id" | "id_ciudadA" | "id_ciudadB"> & {
    ciudadA: Pick<ICiudad, "id" | "name"> | null;
    ciudadB: Pick<ICiudad, "id" | "name"> | null;
  }) | null;
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
          attributes: [...POSTE_PUBLIC_ATTRIBUTES],
          include: [
            { model: MaterialModel },
            { model: PropietarioModel },
            { model: CiudadModel, as: "ciudadA" },
            { model: CiudadModel, as: "ciudadB" },
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
          attributes: [...POSTE_PUBLIC_ATTRIBUTES],
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
        { model: SolucionModel, attributes: [...SOLUCION_PUBLIC_ATTRIBUTES] },
        { model: RevisionModel, attributes: [...REVISION_PUBLIC_ATTRIBUTES] },
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
          attributes: [...POSTE_PUBLIC_ATTRIBUTES],
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
        { model: SolucionModel, attributes: [...SOLUCION_PUBLIC_ATTRIBUTES] },
        { model: RevisionModel, attributes: [...REVISION_PUBLIC_ATTRIBUTES] },
        {
          model: EventoObsModel,
          attributes: ["id", "id_obs"],
          include: [{ model: ObsModel, as: "ob", attributes: ["id", "name", "criticality"] }],
        },
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
      // Normalizar tramo: el de menor id siempre como ciudadA. Así (1,2) y (2,1) se cuentan juntos.
      const aIsMin = pd.id_ciudadA <= pd.id_ciudadB;
      const minId = aIsMin ? pd.id_ciudadA : pd.id_ciudadB;
      const maxId = aIsMin ? pd.id_ciudadB : pd.id_ciudadA;
      const minName = (aIsMin ? pd.ciudadA?.name : pd.ciudadB?.name) ?? `#${minId}`;
      const maxName = (aIsMin ? pd.ciudadB?.name : pd.ciudadA?.name) ?? `#${maxId}`;
      const key = `${minId}-${maxId}`;
      if (!tramoMap.has(key)) {
        tramoMap.set(key, {
          ciudadAId: minId,
          ciudadBId: maxId,
          ciudadAName: minName,
          ciudadBName: maxName,
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
        attributes: ["id", "name", "criticality"],
        include: [{ model: TipoObsModel, as: "tipoObs", attributes: ["id", "name"] }],
      }],
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}

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

export async function putTiemposResumen(req: Request, res: Response) {
  const { fechaInicial, fechaFinal } = req.body;
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const eventIds = await getEventIdsRepairedInRange(new Date(fechaInicial), new Date(fechaFinal));
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
      ciudadAName: string; ciudadBName: string; dias: number[]; visitas: number[];
    }>();

    let descartados = 0;

    for (const e of eventos) {
      const ed = e.toJSON() as unknown as IEventoConSolucion;
      const p = ed.poste;
      if (!p || !ed.date) continue;

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

      // Normalizar tramo: el de menor id siempre como ciudadA. Así (1,2) y (2,1) se cuentan juntos.
      const aIsMin = p.id_ciudadA <= p.id_ciudadB;
      const minId = aIsMin ? p.id_ciudadA : p.id_ciudadB;
      const maxId = aIsMin ? p.id_ciudadB : p.id_ciudadA;
      const minName = (aIsMin ? p.ciudadA?.name : p.ciudadB?.name) ?? `#${minId}`;
      const maxName = (aIsMin ? p.ciudadB?.name : p.ciudadA?.name) ?? `#${maxId}`;
      const key = `${minId}-${maxId}`;
      if (!tramoMap.has(key)) {
        tramoMap.set(key, {
          ciudadAId: minId,
          ciudadBId: maxId,
          ciudadAName: minName,
          ciudadBName: maxName,
          dias: [],
          visitas: [],
        });
      }
      tramoMap.get(key)!.dias.push(dias);
      tramoMap.get(key)!.visitas.push((ed.revisions ?? []).length);
    }

    const result = [...tramoMap.values()]
      .filter((t) => t.dias.length > 0)
      .map((t) => ({
        ciudadAId: t.ciudadAId,
        ciudadBId: t.ciudadBId,
        ciudadAName: t.ciudadAName,
        ciudadBName: t.ciudadBName,
        count: t.dias.length,
        avgVisitas: Math.round((t.visitas.reduce((s, v) => s + v, 0) / t.visitas.length) * 10) / 10,
        avgDias: Math.round(t.dias.reduce((s, d) => s + d, 0) / t.dias.length),
        minDias: Math.min(...t.dias),
        maxDias: Math.max(...t.dias),
      }))
      .sort((a, b) => b.avgDias - a.avgDias);

    res.status(200).json({ tramos: result, descartados });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}
