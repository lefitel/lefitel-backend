import { Request, Response } from "express";
import { Op, fn, col } from "sequelize";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { logAction } from "../utils/logAction.js";
import { assignable } from "../utils/authorship.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const materialLog = log("material");
const handler = makeHandler(materialLog);

interface CountRow { id: number; name: string; count: string }

export const getMaterialStats = handler("getMaterialStats", async (req: Request, res: Response) => {
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
});

export const getMaterial = handler("getMaterial", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";

  const TempMaterial = await MaterialModel.findAll({
    order: [["id", "DESC"]],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
  });
  res.status(200).json(TempMaterial);
});
export const createMaterial = handler("createMaterial", async (req: Request, res: Response) => {
  const TempMaterial = await MaterialModel.create(assignable(req.body));
  logAction({ id_usuario: req.user?.id, action: "CREATE_MATERIAL", entity: "Material", entity_id: TempMaterial.dataValues.id as number, detail: `Creó material ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
  res.status(200).json(TempMaterial);
});
export const updateMaterial = handler("updateMaterial", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempMaterial = await MaterialModel.findOne({ where: { id } });
  if (!TempMaterial) return res.status(404).json({ message: "Material no encontrado" });
  const dv = TempMaterial.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written. `assignable` refuses
  // id/createdAt/updatedAt/deletedAt at the write, and an entry that records the
  // refused change is worse than no entry at all: the bitácora is where a reader
  // goes to find out whether the row was archived.
  const editable = assignable(req.body);
  const beforeMaterial = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempMaterial.set(editable);
  await TempMaterial.save();
  logAction({ id_usuario: req.user?.id, action: "UPDATE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Editó material #${id}`, metadata: { before: beforeMaterial, after: editable }, severity: 'warning' });
  res.status(200).json(TempMaterial);
});
export const deleteMaterial = handler("deleteMaterial", async (req: Request, res: Response) => {
  const { id } = req.params;

  await MaterialModel.destroy({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "DELETE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Archivó material #${id}`, severity: 'critical' });
  return res.sendStatus(200);
});
export const desarchivarMaterial = handler("desarchivarMaterial", async (req: Request, res: Response) => {
  const { id } = req.params;

  await MaterialModel.restore({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_MATERIAL", entity: "Material", entity_id: Number(id), detail: `Desarchivó material #${id}`, severity: 'info' });
  return res.sendStatus(200);
});
