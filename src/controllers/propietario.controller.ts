import { Request, Response } from "express";
import { Op } from "sequelize";
import { PropietarioModel } from "../models/propietario.model.js";
import { logAction } from "../utils/logAction.js";

export async function getPropietario(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempPropietario = await PropietarioModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createPropietario(req: Request, res: Response) {
  try {
    const TempPropietario = await PropietarioModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_PROPIETARIO", entity: "Propietario", entity_id: TempPropietario.dataValues.id as number, detail: `Creó propietario ${req.body.name}` });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updatePropietario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempPropietario = await PropietarioModel.findOne({ where: { id } });
    if (!TempPropietario) return res.status(404).json({ message: "Propietario no encontrado" });
    TempPropietario.set(req.body);
    await TempPropietario.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_PROPIETARIO", entity: "Propietario", entity_id: Number(id), detail: `Editó propietario #${id}` });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deletePropietario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PropietarioModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_PROPIETARIO", entity: "Propietario", entity_id: Number(id), detail: `Archivó propietario #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarPropietario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PropietarioModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_PROPIETARIO", entity: "Propietario", entity_id: Number(id), detail: `Desarchivó propietario #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
