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
  const { ciudadA, ciudadB, ciudadId, archived, page, limit, filterColumn, filterValue, export: isExport } = req.query;
  const isArchived = archived === "true";

  const where: Record<string, unknown> = isArchived
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

  if (filterColumn && filterValue && typeof filterValue === "string" && filterValue.trim()) {
    if (filterColumn === "name") {
      where["name"] = { [Op.iLike]: `%${filterValue.trim()}%` };
    }
  }

  const queryOptions = {
    where,
    paranoid: !isArchived,
    order: [["id", ciudadA && ciudadB ? "ASC" : "DESC"]] as [[string, string]],
    attributes: {
      include: [[
        literal(`(SELECT COUNT(*) FROM "eventos" WHERE "eventos"."id_poste" = "poste"."id" AND "eventos"."state" = false AND "eventos"."deletedAt" IS NULL)`),
        "pendingEvents",
      ] as [ReturnType<typeof literal>, string]],
      exclude: ["image"],
    },
    include: [
      { model: MaterialModel, paranoid: false, attributes: ["id", "name"] },
      { model: PropietarioModel, paranoid: false, attributes: ["id", "name"] },
      { model: CiudadModel, as: "ciudadA", paranoid: false, attributes: ["id", "name"] },
      { model: CiudadModel, as: "ciudadB", paranoid: false, attributes: ["id", "name"] },
      { model: UsuarioModel, attributes: ["id", "name", "lastname"] },
    ],
  };

  try {
    if (isExport === "true") {
      const data = await PosteModel.findAll(queryOptions);
      return res.status(200).json(data);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(15, Number(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    const { count, rows } = await PosteModel.findAndCountAll({
      ...queryOptions,
      limit: limitNum,
      offset,
    });

    return res.status(200).json({
      data: rows,
      total: count,
      page: pageNum,
      totalPages: Math.ceil(count / limitNum),
      limit: limitNum,
    });
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
