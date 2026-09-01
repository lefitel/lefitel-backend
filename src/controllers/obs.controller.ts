import { Request, Response } from "express";
import { Op } from "sequelize";
import { ObsModel } from "../models/obs.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { logAction } from "../utils/logAction.js";
import { assignable } from "../utils/authorship.js";

export async function getObsStats(req: Request, res: Response) {
  try {
    const total = await ObsModel.count();
    const unclassified = await ObsModel.count({ where: { criticality: null } });
    const critical = await ObsModel.count({ where: { criticality: { [Op.between]: [1, 3] } } });
    res.status(200).json({ total, unclassified, critical });
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : "Error" });
  }
}

export async function getObs(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempObs = await ObsModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
      include: [{ model: TipoObsModel, as: "tipoObs", paranoid: false }],
    });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createObs(req: Request, res: Response) {
  try {
    const TempObs = await ObsModel.create(assignable(req.body));
    const tipoRow = req.body.id_tipoObs != null ? await TipoObsModel.findByPk(req.body.id_tipoObs, { attributes: ["id", "name"], paranoid: false }) : null;
    const tipoRef = tipoRow ? { id: tipoRow.dataValues.id, name: tipoRow.dataValues.name } : (req.body.id_tipoObs ?? null);
    logAction({ id_usuario: req.user?.id, action: "CREATE_OBS", entity: "Obs", entity_id: TempObs.dataValues.id as number, detail: `Creó observación ${req.body.name}`, metadata: { after: { name: req.body.name, id_tipoObs: tipoRef } }, severity: 'info' });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempObs = await ObsModel.findOne({ where: { id } });
    if (!TempObs) return res.status(404).json({ message: "Observación no encontrada" });
    const dv = TempObs.dataValues as unknown as Record<string, unknown>;
    // The diff is built from what will actually be written. `assignable` refuses
    // id/createdAt/updatedAt/deletedAt at the write, and an entry that records the
    // refused change is worse than no entry at all: the bitácora is where a reader
    // goes to find out whether the row was archived. Built through a variable, so
    // `logShape.test.ts` cannot see this one — see its header.
    const editable = assignable(req.body);
    const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
    const beforeMeta: Record<string, unknown> = {};
    const afterMeta:  Record<string, unknown> = {};
    for (const k of Object.keys(editable)) {
      const bv = dv[k];
      if (bv === undefined || k === "id_tipoObs") continue;
      if (isPrimVal(bv) && isPrimVal(editable[k])) { beforeMeta[k] = bv; afterMeta[k] = editable[k]; }
    }
    const bvTipo = dv["id_tipoObs"] as number | null | undefined;
    const avTipo = editable["id_tipoObs"] as number | null | undefined;
    // Only when the request actually carries it: without this, a body that omits
    // `id_tipoObs` recorded a change from the current type to nothing. And the
    // logAction below is unconditional, so it really was written every time.
    if (Object.hasOwn(editable, "id_tipoObs") && bvTipo !== undefined && bvTipo !== avTipo) {
      const fkRef = async (pkVal: number | null | undefined) => {
        if (pkVal == null) return null;
        const row = await TipoObsModel.findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
        return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
      };
      [beforeMeta["id_tipoObs"], afterMeta["id_tipoObs"]] = await Promise.all([fkRef(bvTipo), fkRef(avTipo)]);
    }
    TempObs.set(editable);
    await TempObs.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_OBS", entity: "Obs", entity_id: Number(id), detail: `Editó observación #${id}`, metadata: { before: beforeMeta, after: afterMeta }, severity: 'warning' });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await ObsModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_OBS", entity: "Obs", entity_id: Number(id), detail: `Archivó observación #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarObs(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await ObsModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_OBS", entity: "Obs", entity_id: Number(id), detail: `Desarchivó observación #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
