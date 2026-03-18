import { Request, Response } from "express";
import { Op } from "sequelize";
import { MaterialModel } from "../models/material.model.js";
import { logAction } from "../utils/logAction.js";

export async function getMaterial(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempMaterial = await MaterialModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createMaterial(req: Request, res: Response) {
  try {
    const TempMaterial = await MaterialModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_MATERIAL", entity: "Material", entity_id: TempMaterial.dataValues.id as number, detail: `Creó material ${req.body.name}` });
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateMaterial(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempMaterial = await MaterialModel.findOne({ where: { id } });
    if (!TempMaterial) return res.status(404).json({ message: "Material no encontrado" });
    TempMaterial.set(req.body);
    await TempMaterial.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Editó material #${id}` });
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteMaterial(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await MaterialModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Archivó material #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarMaterial(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await MaterialModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Desarchivó material #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
