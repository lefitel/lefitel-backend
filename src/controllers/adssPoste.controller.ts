import { Request, Response } from "express";
import { AdssPosteModel } from "../models/adssPoste.model.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const adssPosteLog = log("adssPoste");
const handler = makeHandler(adssPosteLog);

export const getAdssPoste = handler("getAdssPoste", async (req: Request, res: Response) => {
  const { id } = req.params;
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const listado = await listar(AdssPosteModel, {
    where: { id_poste: id },
    order: [["id", "DESC"]],
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});
