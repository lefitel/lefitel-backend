import { Request, Response } from "express";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const eventoObsLog = log("eventoObs");
const handler = makeHandler(eventoObsLog);

export const getEventoObs = handler("getEventoObs", async (req: Request, res: Response) => {
  const { id } = req.params;
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const listado = await listar(EventoObsModel, {
    where: { id_evento: id },
    order: [["id", "DESC"]],
    // This feeds the event detail screen's observation chips. Sending the name
    // without `criticality` is why that screen showed no severity at all: you
    // could arrive there from a "crítica" alert and read nothing about how
    // bad it is.
    include: [{ model: ObsModel, paranoid: false, attributes: ["id", "name", "criticality"] }],
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});
