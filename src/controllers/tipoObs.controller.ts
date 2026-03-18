import { Request, Response } from "express";
import { Op } from "sequelize";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { logAction } from "../utils/logAction.js";

export async function getTipoObs(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempTipoObs = await TipoObsModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createTipoObs(req: Request, res: Response) {
  try {
    const TempTipoObs = await TipoObsModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_TIPO_OBS", entity: "TipoObs", entity_id: TempTipoObs.dataValues.id as number, detail: `Creó tipo de observación ${req.body.name}` });
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateTipoObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempTipoObs = await TipoObsModel.findOne({ where: { id } });
    if (!TempTipoObs) return res.status(404).json({ message: "Tipo de observación no encontrado" });
    TempTipoObs.set(req.body);
    await TempTipoObs.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Editó tipo de observación #${id}` });
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteTipoObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await TipoObsModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Archivó tipo de observación #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarTipoObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await TipoObsModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Desarchivó tipo de observación #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
