import { Request, Response } from "express";
import { Op, fn, col } from "sequelize";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { ObsModel } from "../models/obs.model.js";
import { logAction } from "../utils/logAction.js";
import { assignable } from "../utils/authorship.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const tipoObsLog = log("tipoObs");
const handler = makeHandler(tipoObsLog);

interface CountRow { id: number; name: string; count: string }

export const getTipoObsStats = handler("getTipoObsStats", async (req: Request, res: Response) => {
  const total = await TipoObsModel.count();
  const usage = await TipoObsModel.findAll({
    attributes: [
      "id",
      "name",
      [fn("COUNT", col("obs.id")), "count"],
    ],
    include: [{ model: ObsModel, attributes: [], required: false }],
    group: ["tipoObs.id"],
    raw: true,
  }) as unknown as CountRow[];
  const sorted = [...usage].map((r) => ({ ...r, count: Number(r.count) }))
    .sort((a, b) => b.count - a.count);
  const mostUsed = sorted[0] && sorted[0].count > 0 ? { name: sorted[0].name, count: sorted[0].count } : null;
  const empty = sorted.filter((r) => r.count === 0).length;
  res.status(200).json({ total, mostUsed, empty });
});

export const getTipoObs = handler("getTipoObs", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";

  const TempTipoObs = await TipoObsModel.findAll({
    order: [["id", "DESC"]],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
  });
  res.status(200).json(TempTipoObs);
});
export const createTipoObs = handler("createTipoObs", async (req: Request, res: Response) => {
  const TempTipoObs = await TipoObsModel.create(assignable(req.body));
  logAction({ id_usuario: req.user?.id, action: "CREATE_TIPO_OBS", entity: "TipoObs", entity_id: TempTipoObs.dataValues.id as number, detail: `Creó tipo de observación ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
  res.status(200).json(TempTipoObs);
});
export const updateTipoObs = handler("updateTipoObs", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempTipoObs = await TipoObsModel.findOne({ where: { id } });
  if (!TempTipoObs) return res.status(404).json({ message: "Tipo de observación no encontrado" });
  const dv = TempTipoObs.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written. `assignable` refuses
  // id/createdAt/updatedAt/deletedAt at the write, and an entry that records the
  // refused change is worse than no entry at all: the bitácora is where a reader
  // goes to find out whether the row was archived.
  const editable = assignable(req.body);
  const beforeTipoObs = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempTipoObs.set(editable);
  await TempTipoObs.save();
  logAction({ id_usuario: req.user?.id, action: "UPDATE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Editó tipo de observación #${id}`, metadata: { before: beforeTipoObs, after: editable }, severity: 'warning' });
  res.status(200).json(TempTipoObs);
});
export const deleteTipoObs = handler("deleteTipoObs", async (req: Request, res: Response) => {
  const { id } = req.params;

  await TipoObsModel.destroy({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "DELETE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Archivó tipo de observación #${id}`, severity: 'critical' });
  return res.sendStatus(200);
});
export const desarchivarTipoObs = handler("desarchivarTipoObs", async (req: Request, res: Response) => {
  const { id } = req.params;

  await TipoObsModel.restore({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Desarchivó tipo de observación #${id}`, severity: 'info' });
  return res.sendStatus(200);
});
