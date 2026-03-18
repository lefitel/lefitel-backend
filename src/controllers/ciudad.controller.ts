import { Request, Response } from "express";
import { Op } from "sequelize";
import { CiudadModel } from "../models/ciudad.model.js";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";

export async function getCiudad(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempCiudad = await CiudadModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempCiudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createCiudad(req: Request, res: Response) {
  try {
    const TempCiudad = await CiudadModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_CIUDAD", entity: "Ciudad", entity_id: TempCiudad.dataValues.id as number, detail: `Creó ciudad ${req.body.name}` });
    res.status(200).json(TempCiudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateCiudad(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempCiudad = await CiudadModel.findOne({ where: { id } });
    if (!TempCiudad) return res.status(404).json({ message: "Ciudad no encontrada" });
    const oldImage = TempCiudad.dataValues.image;
    TempCiudad.set(req.body);
    await TempCiudad.save();
    if (oldImage && req.body.image && oldImage !== req.body.image) {
      deleteImageFile(oldImage);
    }
    logAction({ id_usuario: req.user?.id, action: "UPDATE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Editó ciudad #${id}` });
    res.status(200).json(TempCiudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function searchCiudad(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const ciudad = await CiudadModel.findByPk(Number(id));
    if (!ciudad) return res.status(404).json({ message: "Ciudad no encontrada" });
    res.status(200).json(ciudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarCiudad(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await CiudadModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Desarchivó ciudad #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteCiudad(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await CiudadModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Archivó ciudad #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
