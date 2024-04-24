import { AdssModel } from "../models/adss.model.js";
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

export async function putReporteGeneral(req, res) {
  const { fechaInicial, fechaFinal } = req.body;
  const fechaInicio = new Date(fechaInicial);
  const fechaFin = new Date(fechaFinal);
  //fechaInicio.setHours(4, 0, 0, 0);
  //fechaFin.setHours(4, 0, 0, 0);
  //fechaFin.setDate(fechaFin.getDate() + 1);
  try {
    const TempReporte = await EventoModel.findAll({
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
      where: {
        date: {
          [Op.gte]: fechaInicio,
          [Op.lt]: fechaFin,
        },
      },
    });
    res.status(200).json(TempReporte);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function putReporteTramo(req, res) {
  const { fechaInicial, fechaFinal, TramoInicial, TramoFinal } = req.body;
  const fechaInicio = new Date(fechaInicial);
  const fechaFin = new Date(fechaFinal);

  try {
    console.log("================");

    const TempReporte = await EventoModel.findAll({
      order: [["id", "DESC"]],
      include: [
        { model: EventoObsModel },
        {
          model: PosteModel,
          include: [
            { model: MaterialModel },
            { model: AdssPosteModel },

            { model: PropietarioModel },
            {
              model: CiudadModel,
              as: "ciudadA",
            },
            {
              model: CiudadModel,
              as: "ciudadB",
            },
          ],
          where: {
            [Op.or]: [{ id_ciudadA: TramoInicial }, { id_ciudadA: TramoFinal }],
            [Op.or]: [{ id_ciudadB: TramoInicial }, { id_ciudadB: TramoFinal }],
          },
        },
        { model: SolucionModel },
        { model: RevicionModel },
      ],
      where: {
        date: {
          [Op.gte]: fechaInicio,
          [Op.lt]: fechaFin,
        },
      },
    });
    console.log("Model");
    console.log(TempReporte);

    res.status(200).json(TempReporte);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
