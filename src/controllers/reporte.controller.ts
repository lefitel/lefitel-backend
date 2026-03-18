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
  const { fechaInicial, fechaFinal } = req.body;
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const eventIds = await getEventIdsInRange(new Date(fechaInicial), new Date(fechaFinal));
    const data = await EventoModel.findAll({
      where: { id: { [Op.in]: eventIds } },
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
  const { fechaInicial, fechaFinal, TramoInicial, TramoFinal } = req.body;
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
    const eventIds = await getEventIdsInRange(new Date(fechaInicial), new Date(fechaFinal));
    const data = await EventoModel.findAll({
      where: { id: { [Op.in]: eventIds } },
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
  const { TramoInicial, TramoFinal, fechaInicial, fechaFinal } = req.body;
  if (!TramoInicial || !TramoFinal) {
    return res.status(400).json({ message: "TramoInicial y TramoFinal son requeridos" });
  }
  if (!fechaInicial || !fechaFinal) {
    return res.status(400).json({ message: "fechaInicial y fechaFinal son requeridos" });
  }
  try {
    const eventIds = await getEventIdsInRange(new Date(fechaInicial), new Date(fechaFinal));
    const data = await EventoModel.findAll({
      where: { id: { [Op.in]: eventIds } },
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
