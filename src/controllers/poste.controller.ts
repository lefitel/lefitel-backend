import { Request, Response } from "express";
import { literal, Op } from "sequelize";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { UsuarioModel } from "../models/usuario.model.js";

export async function getPoste(req: Request, res: Response) {
  const { ciudadA, ciudadB, ciudadId, archived } = req.query;
  const isArchived = archived === "true";
  const where = isArchived
    ? { deletedAt: { [Op.ne]: null } }
    : ciudadId
    ? { [Op.or]: [{ id_ciudadA: Number(ciudadId) }, { id_ciudadB: Number(ciudadId) }] }
    : (ciudadA && ciudadB)
      ? {
          [Op.or]: [
            { id_ciudadA: Number(ciudadA), id_ciudadB: Number(ciudadB) },
            { id_ciudadA: Number(ciudadB), id_ciudadB: Number(ciudadA) },
          ],
        }
      : {};
  try {
    const TempPoste = await PosteModel.findAll({
      where,
      paranoid: !isArchived,
      order: [["id", ciudadA && ciudadB ? "ASC" : "DESC"]],
      attributes: {
        include: [[
          literal(`(SELECT COUNT(*) FROM "eventos" WHERE "eventos"."id_poste" = "poste"."id" AND "eventos"."state" = false AND "eventos"."deletedAt" IS NULL)`),
          "pendingEvents",
        ]],
      },
      include: [
        { model: MaterialModel, paranoid: false },
        { model: PropietarioModel, paranoid: false },
        { model: CiudadModel, as: "ciudadA", paranoid: false },
        { model: CiudadModel, as: "ciudadB", paranoid: false },
        { model: UsuarioModel },
      ],
    });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createPoste(req: Request, res: Response) {
  try {
    const TempPoste = await PosteModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_POSTE", entity: "Poste", entity_id: TempPoste.dataValues.id as number, detail: `Registró Poste ${req.body.name}` });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function searchPoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempPoste = await PosteModel.findOne({
      where: { id },
      include: [
        { model: MaterialModel, paranoid: false },
        { model: PropietarioModel, paranoid: false },
        { model: CiudadModel, as: "ciudadA", paranoid: false },
        { model: CiudadModel, as: "ciudadB", paranoid: false },
        { model: UsuarioModel },
      ],
    });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updatePoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempPoste = await PosteModel.findOne({ where: { id } });
    if (!TempPoste) return res.status(404).json({ message: "Poste no encontrado" });
    const oldImage = TempPoste.dataValues.image;
    TempPoste.set(req.body);
    await TempPoste.save();
    if (oldImage && req.body.image && oldImage !== req.body.image) {
      deleteImageFile(oldImage);
    }
    logAction({ id_usuario: req.user?.id, action: "UPDATE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Editó Poste #${id}` });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deletePoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PosteModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Archivó Poste #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarPoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PosteModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Desarchivó Poste #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
