import { Request, Response } from "express";
import { Op, fn, col } from "sequelize";
import { AdssModel } from "../models/adss.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { logAction } from "../utils/logAction.js";
import { assignable } from "../utils/authorship.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const adssLog = log("adss");
const handler = makeHandler(adssLog);

interface CountRow { id: number; name: string; count: string }

export const getAdssStats = handler("getAdssStats", async (req: Request, res: Response) => {
  const total = await AdssModel.count();
  const usage = await AdssModel.findAll({
    attributes: [
      "id",
      "name",
      [fn("COUNT", col("adsspostes.id")), "count"],
    ],
    include: [{ model: AdssPosteModel, attributes: [], required: false }],
    group: ["adss.id"],
    raw: true,
  }) as unknown as CountRow[];
  const sorted = [...usage].map((r) => ({ ...r, count: Number(r.count) }))
    .sort((a, b) => b.count - a.count);
  const mostUsed = sorted[0] && sorted[0].count > 0 ? { name: sorted[0].name, count: sorted[0].count } : null;
  const empty = sorted.filter((r) => r.count === 0).length;
  res.status(200).json({ total, mostUsed, empty });
});

export const getAdss = handler("getAdss", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";

  const TempAdss = await AdssModel.findAll({
    order: [["id", "DESC"]],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
  });
  res.status(200).json(TempAdss);
});
export const createAdss = handler("createAdss", async (req: Request, res: Response) => {
  const TempAdss = await AdssModel.create(assignable(req.body));
  logAction({ id_usuario: req.user?.id, action: "CREATE_ADSS", entity: "Adss", entity_id: TempAdss.dataValues.id as number, detail: `Creó ferretería ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
  res.status(200).json(TempAdss);
});
export const updateAdss = handler("updateAdss", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempAdss = await AdssModel.findOne({ where: { id } });
  if (!TempAdss) return res.status(404).json({ message: "Adss no encontrado" });
  const dv = TempAdss.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written. `assignable` refuses
  // id/createdAt/updatedAt/deletedAt at the write, and an entry that records the
  // refused change is worse than no entry at all: the bitácora is where a reader
  // goes to find out whether the row was archived.
  const editable = assignable(req.body);
  const beforeAdss = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempAdss.set(editable);
  await TempAdss.save();
  logAction({ id_usuario: req.user?.id, action: "UPDATE_ADSS", entity: "Adss", entity_id: Number(id), detail: `Editó ferretería #${id}`, metadata: { before: beforeAdss, after: editable }, severity: 'warning' });
  res.status(200).json(TempAdss);
});
export const deleteAdss = handler("deleteAdss", async (req: Request, res: Response) => {
  const { id } = req.params;

  await AdssModel.destroy({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "DELETE_ADSS", entity: "Adss", entity_id: Number(id), detail: `Archivó ferretería #${id}`, severity: 'critical' });
  return res.sendStatus(200);
});
export const desarchivarAdss = handler("desarchivarAdss", async (req: Request, res: Response) => {
  const { id } = req.params;

  await AdssModel.restore({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_ADSS", entity: "Adss", entity_id: Number(id), detail: `Desarchivó ferretería #${id}`, severity: 'info' });
  return res.sendStatus(200);
});
