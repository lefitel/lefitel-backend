import { Request, Response } from "express";
import { RevicionModel } from "../models/revicion.model.js";
import { logAction } from "../utils/logAction.js";

export async function getRevicion(req: Request, res: Response) {
  const { id_evento } = req.params;

  try {
    const TempRevicion = await RevicionModel.findAll({
      where: { id_evento },

      order: [["id", "DESC"]],
    });
    res.status(200).json(TempRevicion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createRevicion(req: Request, res: Response) {
  try {
    const TempRevicion = await RevicionModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "ADD_REVISION", entity: "Revisión", entity_id: Number(req.body.id_evento), detail: `Agregó revisión al Evento #${req.body.id_evento}` });
    res.status(200).json(TempRevicion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateRevicion(req: Request, res: Response) {
  const { id } = req.params;
  if (id) {
    try {
      const TempRevicion = await RevicionModel.findOne({ where: { id } });
      if (!TempRevicion) return res.status(404).json({ message: "Revisión no encontrada" });
      TempRevicion.set(req.body);
      await TempRevicion.save();
      res.status(200).json(TempRevicion);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  } else {
    try {
      const TempRevicion = await RevicionModel.create(req.body);
      res.status(200).json(TempRevicion);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
}
export async function deleteRevicion(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await RevicionModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
