import { Request, Response } from "express";
import { Op, fn, col } from "sequelize";
import { AdssModel } from "../models/adss.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { logAction } from "../utils/logAction.js";

interface CountRow { id: number; name: string; count: string }

export async function getAdssStats(req: Request, res: Response) {
  try {
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
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : "Error" });
  }
}

export async function getAdss(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempAdss = await AdssModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createAdss(req: Request, res: Response) {
  try {
    const TempAdss = await AdssModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_ADSS", entity: "Adss", entity_id: TempAdss.dataValues.id as number, detail: `Creó ferretería ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateAdss(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempAdss = await AdssModel.findOne({ where: { id } });
    if (!TempAdss) return res.status(404).json({ message: "Adss no encontrado" });
    const dv = TempAdss.dataValues as unknown as Record<string, unknown>;
    const beforeAdss = Object.fromEntries(Object.keys(req.body).map(k => [k, dv[k]]));
    TempAdss.set(req.body);
    await TempAdss.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_ADSS", entity: "Adss", entity_id: Number(id), detail: `Editó ferretería #${id}`, metadata: { before: beforeAdss, after: req.body }, severity: 'warning' });
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteAdss(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await AdssModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_ADSS", entity: "Adss", entity_id: Number(id), detail: `Archivó ferretería #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarAdss(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await AdssModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_ADSS", entity: "Adss", entity_id: Number(id), detail: `Desarchivó ferretería #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
