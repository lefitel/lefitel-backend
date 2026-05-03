import { Request, Response } from "express";
import { Op, fn, col } from "sequelize";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { logAction } from "../utils/logAction.js";

interface CountRow { id: number; name: string; count: string }

export async function getMaterialStats(req: Request, res: Response) {
  try {
    const total = await MaterialModel.count();
    const usage = await MaterialModel.findAll({
      attributes: [
        "id",
        "name",
        [fn("COUNT", col("postes.id")), "count"],
      ],
      include: [{ model: PosteModel, attributes: [], required: false }],
      group: ["material.id"],
      raw: true,
    }) as unknown as CountRow[];
    const sorted = [...usage].map((r) => ({ ...r, count: Number(r.count) }))
      .sort((a, b) => b.count - a.count);
    const mostUsed = sorted[0] && sorted[0].count > 0 ? { name: sorted[0].name, count: sorted[0].count } : null;
    const empty = sorted.filter((r) => r.count === 0).length;
    res.status(200).json({ total, mostUsed, empty });
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : "Error" });
  }
}

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
    logAction({ id_usuario: req.user?.id, action: "CREATE_MATERIAL", entity: "Material", entity_id: TempMaterial.dataValues.id as number, detail: `Creó material ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
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
    const dv = TempMaterial.dataValues as unknown as Record<string, unknown>;
    const beforeMaterial = Object.fromEntries(Object.keys(req.body).map(k => [k, dv[k]]));
    TempMaterial.set(req.body);
    await TempMaterial.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Editó material #${id}`, metadata: { before: beforeMaterial, after: req.body }, severity: 'warning' });
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteMaterial(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await MaterialModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Archivó material #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarMaterial(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await MaterialModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Desarchivó material #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
