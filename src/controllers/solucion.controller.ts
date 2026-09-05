import { Request, Response } from "express";
import { SolucionModel, SOLUCION_PUBLIC_ATTRIBUTES } from "../models/solucion.model.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const solucionLog = log("solucion");
const handler = makeHandler(solucionLog);

// One function left. `getSolucion`, `createSolucion`, `updateSolucion` and
// `deleteSolucion` are gone — see `solucion.routes.ts` and §7 of the API
// standard spec. Writing a repair is `POST /api/evento/:id/resolve`, undoing it
// is `reopen`, and both move the event's state in the same transaction, which
// is the whole reason the loose CRUD could not stay.

export const getSolucion_evento = handler("getSolucion_evento", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempSolucion = await SolucionModel.findOne({
    where: { id_evento: id },
    // See SOLUCION_PUBLIC_ATTRIBUTES. The author is provenance and stays out
    // of a REST answer: C5 gated this route with `eventos.ver`, which is the
    // permission to read the work, not to know who did it.
    attributes: [...SOLUCION_PUBLIC_ATTRIBUTES],
    order: [["id", "DESC"]],
  });
  res.status(200).json(TempSolucion);
});
