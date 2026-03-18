import { Request, Response } from "express";
import { SolucionModel } from "../models/solucion.model.js";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";

export async function getSolucion(req: Request, res: Response) {
  try {
    const TempSolucion = await SolucionModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getSolucion_evento(req: Request, res: Response) {
  const { id_evento } = req.params;

  try {
    const TempSolucion = await SolucionModel.findOne({
      where: { id_evento },
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createSolucion(req: Request, res: Response) {
  try {
    const TempSolucion = await SolucionModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_SOLUCION", entity: "Solución", entity_id: Number(req.body.id_evento), detail: `Registró solución para Evento #${req.body.id_evento}` });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateSolucion(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempSolucion = await SolucionModel.findOne({ where: { id } });
    if (!TempSolucion) return res.status(404).json({ message: "Solución no encontrada" });
    const oldImage = TempSolucion.dataValues.image;
    TempSolucion.set(req.body);
    await TempSolucion.save();
    if (oldImage && req.body.image && oldImage !== req.body.image) {
      deleteImageFile(oldImage);
    }
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteSolucion(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await SolucionModel.destroy({ where: { id } });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
