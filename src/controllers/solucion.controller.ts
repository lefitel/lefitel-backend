import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventoRow = req.body.id_evento != null ? await (EventoModel as any).findByPk(req.body.id_evento, { attributes: ["id", "description"], paranoid: false }) : null;
    const eventoRef = eventoRow ? { id: eventoRow.dataValues.id, name: eventoRow.dataValues.description } : (req.body.id_evento ?? null);
    logAction({ id_usuario: req.user?.id, action: "CREATE_SOLUCION", entity: "Solución", entity_id: Number(req.body.id_evento), detail: `Registró solución para Evento #${req.body.id_evento}`, metadata: { after: { id_evento: eventoRef, description: req.body.description } }, severity: 'info' });
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
    const id_evento = TempSolucion.dataValues.id_evento;
    const oldImage = TempSolucion.dataValues.image;
    const sdv = TempSolucion.dataValues as unknown as Record<string, unknown>;
    const beforeSolucion = Object.fromEntries(Object.keys(req.body).map(k => [k, sdv[k]]));
    TempSolucion.set(req.body);
    await TempSolucion.save();
    if (oldImage && req.body.image && oldImage !== req.body.image) {
      deleteImageFile(oldImage);
    }
    logAction({ id_usuario: req.user?.id, action: "UPDATE_SOLUCION", entity: "Solución", entity_id: Number(id_evento), detail: `Editó solución del Evento #${id_evento}`, metadata: { before: beforeSolucion, after: req.body }, severity: 'warning' });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteSolucion(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempSolucion = await SolucionModel.findOne({ where: { id } });
    const id_evento = TempSolucion?.dataValues.id_evento;
    await SolucionModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_SOLUCION", entity: "Solución", entity_id: id_evento ? Number(id_evento) : null, detail: `Eliminó solución del Evento #${id_evento ?? id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
