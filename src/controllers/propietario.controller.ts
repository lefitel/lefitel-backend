import { Request, Response } from "express";
import { Op, fn, col, literal } from "sequelize";
import { PropietarioModel } from "../models/propietario.model.js";
import { PosteModel } from "../models/poste.model.js";
import { EventoModel } from "../models/evento.model.js";
import { logAction } from "../utils/logAction.js";

interface UsageRow { id: number; name: string; postesCount: string }
interface PendientesRow { name: string; pendientes: string }

export async function getPropietarioStats(req: Request, res: Response) {
  try {
    const total = await PropietarioModel.count();

    const usage = await PropietarioModel.findAll({
      attributes: [
        "id",
        "name",
        [fn("COUNT", col("postes.id")), "postesCount"],
      ],
      include: [{ model: PosteModel, attributes: [], required: false }],
      group: ["propietario.id"],
      raw: true,
    }) as unknown as UsageRow[];
    const sortedUsage = [...usage].map((r) => ({ ...r, postesCount: Number(r.postesCount) }))
      .sort((a, b) => b.postesCount - a.postesCount);
    const mostPostes = sortedUsage[0] && sortedUsage[0].postesCount > 0
      ? { name: sortedUsage[0].name, count: sortedUsage[0].postesCount }
      : null;

    const pendientes = await PropietarioModel.findAll({
      attributes: [
        "name",
        [fn("COUNT", literal("\"postes->eventos\".\"id\"")), "pendientes"],
      ],
      include: [{
        model: PosteModel,
        attributes: [],
        required: false,
        include: [{
          model: EventoModel,
          attributes: [],
          required: false,
          where: { state: false },
        }],
      }],
      group: ["propietario.id"],
      raw: true,
    }) as unknown as PendientesRow[];
    const sortedPend = [...pendientes].map((r) => ({ ...r, pendientes: Number(r.pendientes) }))
      .sort((a, b) => b.pendientes - a.pendientes);
    const mostPendientes = sortedPend[0] && sortedPend[0].pendientes > 0
      ? { name: sortedPend[0].name, count: sortedPend[0].pendientes }
      : null;

    res.status(200).json({ total, mostPostes, mostPendientes });
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : "Error" });
  }
}

export async function getPropietario(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempPropietario = await PropietarioModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createPropietario(req: Request, res: Response) {
  try {
    const TempPropietario = await PropietarioModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_PROPIETARIO", entity: "Propietario", entity_id: TempPropietario.dataValues.id as number, detail: `Creó propietario ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updatePropietario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempPropietario = await PropietarioModel.findOne({ where: { id } });
    if (!TempPropietario) return res.status(404).json({ message: "Propietario no encontrado" });
    const dv = TempPropietario.dataValues as unknown as Record<string, unknown>;
    const beforePropietario = Object.fromEntries(Object.keys(req.body).map(k => [k, dv[k]]));
    TempPropietario.set(req.body);
    await TempPropietario.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_PROPIETARIO", entity: "Propietario", entity_id: Number(id), detail: `Editó propietario #${id}`, metadata: { before: beforePropietario, after: req.body }, severity: 'warning' });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deletePropietario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PropietarioModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_PROPIETARIO", entity: "Propietario", entity_id: Number(id), detail: `Archivó propietario #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarPropietario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PropietarioModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_PROPIETARIO", entity: "Propietario", entity_id: Number(id), detail: `Desarchivó propietario #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
