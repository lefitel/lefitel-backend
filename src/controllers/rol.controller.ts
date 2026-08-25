import { Request, Response } from "express";
import { RolModel } from "../models/rol.model.js";
import { logAction } from "../utils/logAction.js";
import { seedRolePermissions } from "../permissions/store.js";
import { assignable } from "../utils/authorship.js";

export async function getRol(req: Request, res: Response) {
  try {
    const TempRol = await RolModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createRol(req: Request, res: Response) {
  try {
    const TempRol = await RolModel.create(assignable(req.body));
    // A role with no rows in `permisos` has no checkboxes on the Seguridad
    // screen: the administrator would be looking at an empty form with no way
    // to grant anything, and the account would be able to do nothing for ever.
    // Every cell starts denied, which is both safe and editable.
    await seedRolePermissions(TempRol.dataValues.id as number);
    logAction({ id_usuario: req.user?.id, action: "CREATE_ROL", entity: "Rol", entity_id: TempRol.dataValues.id as number, detail: `Creó rol "${req.body.name}"`, metadata: { after: { name: req.body.name } }, severity: 'info' });
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateRol(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempRol = await RolModel.findOne({ where: { id } });
    if (!TempRol) return res.status(404).json({ message: "Rol no encontrado" });
    const dv = TempRol.dataValues as unknown as Record<string, unknown>;
    const beforeRol = Object.fromEntries(Object.keys(req.body).map(k => [k, dv[k]]));
    TempRol.set(assignable(req.body));
    await TempRol.save();
    logAction({ id_usuario: req.user?.id, action: "UPDATE_ROL", entity: "Rol", entity_id: Number(id), detail: `Editó rol #${id}`, metadata: { before: beforeRol, after: req.body }, severity: 'warning' });
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteRol(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await RolModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_ROL", entity: "Rol", entity_id: Number(id), detail: `Eliminó rol #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
