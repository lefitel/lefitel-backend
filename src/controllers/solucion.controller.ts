import { Request, Response } from "express";
import { SolucionModel, SOLUCION_PUBLIC_ATTRIBUTES } from "../models/solucion.model.js";

// One function left. `getSolucion`, `createSolucion`, `updateSolucion` and
// `deleteSolucion` are gone — see `solucion.routes.ts` and §7 of the API
// standard spec. Writing a repair is `POST /api/evento/:id/resolver`, undoing it
// is `reabrir`, and both move the event's state in the same transaction, which
// is the whole reason the loose CRUD could not stay.

export async function getSolucion_evento(req: Request, res: Response) {
  const { id_evento } = req.params;

  try {
    const TempSolucion = await SolucionModel.findOne({
      where: { id_evento },
      // See SOLUCION_PUBLIC_ATTRIBUTES: this route has no permission gate at
      // all, so it must not carry the author.
      attributes: [...SOLUCION_PUBLIC_ATTRIBUTES],
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
