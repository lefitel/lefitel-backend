import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { PosteModel } from "../models/poste.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { MaterialModel } from "../models/material.model.js";
import { RevisionModel } from "../models/revision.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const dashboardLog = log("dashboard");
const handler = makeHandler(dashboardLog);

export const getDashboard = handler("getDashboard", async (req: Request, res: Response) => {
  const [eventos, postes] = await Promise.all([
    EventoModel.findAll({
      attributes: ["id", "description", "state", "date", "priority", "id_poste"],
      include: [
        {
          model: PosteModel,
          attributes: ["id", "name", "lat", "lng"],
          include: [{ model: PropietarioModel, attributes: ["name"] }],
        },
        { model: RevisionModel, attributes: ["id", "date"], separate: true },
        { model: SolucionModel, attributes: ["id", "date"], separate: true },
        {
          model: EventoObsModel,
          attributes: ["id"],
          separate: true,
          include: [{ model: ObsModel, attributes: ["id", "name", "criticality"] }],
        },
      ],
    }),
    PosteModel.findAll({
      attributes: ["id", "name", "lat", "lng", "date"],
      include: [
        { model: CiudadModel, as: "ciudadA", attributes: ["id", "name"] },
        { model: CiudadModel, as: "ciudadB", attributes: ["id", "name"] },
        { model: PropietarioModel, attributes: ["name"] },
        { model: MaterialModel, attributes: ["name"] },
      ],
    }),
  ]);
  res.status(200).json({ eventos, postes });
});
