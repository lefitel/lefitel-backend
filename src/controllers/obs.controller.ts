import { Request, Response } from "express";
import { Op } from "sequelize";
import { ObsModel } from "../models/obs.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { logAction } from "../utils/logAction.js";

export async function getObs(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempObs = await ObsModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
      include: [{ model: TipoObsModel, as: "tipoObs", paranoid: false }],
    });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createObs(req: Request, res: Response) {
  try {
    const TempObs = await ObsModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_OBS", entity: "Obs", entity_id: TempObs.dataValues.id as number, detail: `Creó observación ${req.body.name}` });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempObs = await ObsModel.findOne({ where: { id } });
    if (!TempObs) return res.status(404).json({ message: "Observación no encontrada" });
    TempObs.set(req.body);
    await TempObs.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_OBS", entity: "Obs", entity_id: Number(id), detail: `Editó observación #${id}` });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await ObsModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_OBS", entity: "Obs", entity_id: Number(id), detail: `Archivó observación #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await ObsModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_OBS", entity: "Obs", entity_id: Number(id), detail: `Desarchivó observación #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
