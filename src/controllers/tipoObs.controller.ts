import { Request, Response } from "express";
import { Op, fn, col } from "sequelize";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { ObsModel } from "../models/obs.model.js";
import { logAction } from "../utils/logAction.js";

interface CountRow { id: number; name: string; count: string }

export async function getTipoObsStats(req: Request, res: Response) {
  try {
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
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : "Error" });
  }
}

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
    logAction({ id_usuario: req.user?.id, action: "CREATE_TIPO_OBS", entity: "TipoObs", entity_id: TempTipoObs.dataValues.id as number, detail: `Creó tipo de observación ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
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
    const dv = TempTipoObs.dataValues as unknown as Record<string, unknown>;
    const beforeTipoObs = Object.fromEntries(Object.keys(req.body).map(k => [k, dv[k]]));
    TempTipoObs.set(req.body);
    await TempTipoObs.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Editó tipo de observación #${id}`, metadata: { before: beforeTipoObs, after: req.body }, severity: 'warning' });
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteTipoObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await TipoObsModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Archivó tipo de observación #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarTipoObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await TipoObsModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_TIPO_OBS", entity: "TipoObs", entity_id: Number(id), detail: `Desarchivó tipo de observación #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
