import { Request, Response } from "express";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const eventoObsLog = log("eventoObs");
const handler = makeHandler(eventoObsLog);

export const getEventoObs = handler("getEventoObs", async (req: Request, res: Response) => {
  const { id_evento } = req.params;

  const TempEventoObs = await EventoObsModel.findAll({
    where: { id_evento },
    order: [["id", "DESC"]],
    // This feeds the event detail screen's observation chips. Sending the name
    // without `criticality` is why that screen showed no severity at all: you
    // could arrive there from a "crítica" alert and read nothing about how
    // bad it is.
    include: [{ model: ObsModel, paranoid: false, attributes: ["id", "name", "criticality"] }],
  });
  res.status(200).json(TempEventoObs);
});
