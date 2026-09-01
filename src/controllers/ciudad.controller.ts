import { Request, Response } from "express";
import { Op } from "sequelize";
import { CiudadModel } from "../models/ciudad.model.js";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { assignable } from "../utils/authorship.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const ciudadLog = log("ciudad");
const handler = makeHandler(ciudadLog);

export const getCiudad = handler("getCiudad", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";

  const TempCiudad = await CiudadModel.findAll({
    order: [["id", "DESC"]],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
  });
  res.status(200).json(TempCiudad);
});
export const createCiudad = handler("createCiudad", async (req: Request, res: Response) => {
  const TempCiudad = await CiudadModel.create(assignable(req.body));
  logAction({ id_usuario: req.user?.id, action: "CREATE_CIUDAD", entity: "Ciudad", entity_id: TempCiudad.dataValues.id as number, detail: `Creó ciudad ${req.body.name}`, metadata: { after: { name: req.body.name } }, severity: 'info' });
  res.status(200).json(TempCiudad);
});
export const updateCiudad = handler("updateCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempCiudad = await CiudadModel.findOne({ where: { id } });
  if (!TempCiudad) return res.status(404).json({ message: "Ciudad no encontrada" });
  const oldImage = TempCiudad.dataValues.image;
  const dv = TempCiudad.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written. `assignable` refuses
  // id/createdAt/updatedAt/deletedAt at the write, and an entry that records the
  // refused change is worse than no entry at all: the bitácora is where a reader
  // goes to find out whether the row was archived.
  const editable = assignable(req.body);
  const beforeCiudad = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempCiudad.set(editable);
  await TempCiudad.save();
  if (oldImage && req.body.image && oldImage !== req.body.image) {
    deleteImageFile(oldImage);
  }
  logAction({ id_usuario: req.user?.id, action: "UPDATE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Editó ciudad #${id}`, metadata: { before: beforeCiudad, after: editable }, severity: 'warning' });
  res.status(200).json(TempCiudad);
});
export const searchCiudad = handler("searchCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  const ciudad = await CiudadModel.findByPk(Number(id));
  if (!ciudad) return res.status(404).json({ message: "Ciudad no encontrada" });
  res.status(200).json(ciudad);
});
export const desarchivarCiudad = handler("desarchivarCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  await CiudadModel.restore({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Desarchivó ciudad #${id}`, severity: 'info' });
  return res.sendStatus(200);
});
export const deleteCiudad = handler("deleteCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  await CiudadModel.destroy({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "DELETE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Archivó ciudad #${id}`, severity: 'critical' });
  return res.sendStatus(200);
});
