import { Request, Response } from "express";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";

export async function getEventoObs(req: Request, res: Response) {
  const { id_evento } = req.params;
  try {
    const TempEventoObs = await EventoObsModel.findAll({
      where: { id_evento },
      order: [["id", "DESC"]],
      include: [{ model: ObsModel, paranoid: false, attributes: ["id", "name"] }],
    });
    res.status(200).json(TempEventoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
