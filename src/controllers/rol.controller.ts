import { Request, Response } from "express";
import { Op } from "sequelize";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { logAction } from "../utils/logAction.js";
import { seedRolePermissions } from "../permissions/store.js";
import { assignable } from "../utils/authorship.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const rolLog = log("rol");
const handler = makeHandler(rolLog);

export const getRol = handler("getRol", async (req: Request, res: Response) => {
  // `?archived=true` lists the archived ones instead, the same shape every other
  // manageable entity here uses. Ungated on purpose, like the rest of this read:
  // every screen that shows a person needs the name of their role.
  const isArchived = req.query.archived === "true";
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const listado = await listar(RolModel, {
    where: isArchived ? { deletedAt: { [Op.ne]: null } } : undefined,
    paranoid: !isArchived,
    order: [["id", "DESC"]],
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});

export const createRol = handler("createRol", async (req: Request, res: Response) => {
  const TempRol = await RolModel.create(assignable(req.body));
  // A role with no rows in `permisos` has no checkboxes on the Seguridad
  // screen: the administrator would be looking at an empty form with no way
  // to grant anything, and the account would be able to do nothing for ever.
  // Every cell starts denied, which is both safe and editable.
  await seedRolePermissions(TempRol.dataValues.id as number);
  logAction({ id_usuario: req.user?.id, action: "CREATE_ROL", entity: "Rol", entity_id: TempRol.dataValues.id as number, detail: `Creó rol "${req.body.name}"`, metadata: { after: { name: req.body.name } }, severity: 'info' });
  res.status(200).json(TempRol);
});

export const updateRol = handler("updateRol", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempRol = await RolModel.findOne({ where: { id } });
  if (!TempRol) return res.status(404).json({ message: "Rol no encontrado" });
  const dv = TempRol.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written, not from the body as
  // received. With `after: req.body`, a PUT carrying `deletedAt` archived nothing
  // and still wrote into the bitácora that it had — the defect A0 closed in the
  // other eight controllers while this file belonged to another session.
  const editable = assignable(req.body);
  const beforeRol = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempRol.set(editable);
  await TempRol.save();
  logAction({ id_usuario: req.user?.id, action: "UPDATE_ROL", entity: "Rol", entity_id: Number(id), detail: `Editó rol #${id}`, metadata: { before: beforeRol, after: editable }, severity: 'warning' });
  res.status(200).json(TempRol);
});

/**
 * Archive a role. Refuses while anybody still holds it.
 *
 * This used to be a real DELETE, and `usuarios.id_rol` is ON DELETE CASCADE:
 * 20260822000001-create-sesion.ts records the chain being measured at six users
 * and 4.835 revisions through seventeen keys. So "archive this role" removed the
 * accounts that held it and every field inspection any of them had recorded,
 * and wrote one audit line that said a role was deleted. Nothing was ever lost
 * to it only because no screen called it — which stops being true now that role
 * management reaches the interface.
 *
 * Two things stand between that and this endpoint now. `RolModel` is paranoid,
 * so `destroy()` writes `deletedAt` and the cascade cannot fire. And the count
 * below refuses outright while the role has accounts, because an archived role
 * that people still hold is its own quiet failure: they keep their permissions,
 * the role vanishes from every list, and the Seguridad screen can no longer show
 * or change what they may do.
 *
 * Deliberately not guarded: the three seeded roles are not protected by number.
 * Doing that would put role ids back into decision logic, which this codebase
 * has taken trouble to remove — and it is unnecessary, because a role nobody
 * holds takes nobody's access away when it goes, and can be restored.
 */
export const deleteRol = handler("deleteRol", async (req: Request, res: Response) => {
  const { id } = req.params;

  const rol = await RolModel.findOne({ where: { id } });
  if (!rol) return res.status(404).json({ message: "Rol no encontrado" });

  const enUso = await UsuarioModel.count({ where: { id_rol: id } });
  if (enUso > 0) {
    return res.status(409).json({
      message: enUso === 1
        ? "No se puede archivar: hay 1 cuenta con este rol. Cámbiale el rol antes de archivarlo."
        : `No se puede archivar: hay ${enUso} cuentas con este rol. Cámbiales el rol antes de archivarlo.`,
      cuentas: enUso,
    });
  }

  await rol.destroy();
  logAction({ id_usuario: req.user?.id, action: "DELETE_ROL", entity: "Rol", entity_id: Number(id), detail: `Archivó rol #${id}`, severity: 'critical' });
  return res.sendStatus(200);
});

export const desarchivarRol = handler("desarchivarRol", async (req: Request, res: Response) => {
  const { id } = req.params;

  await RolModel.restore({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_ROL", entity: "Rol", entity_id: Number(id), detail: `Desarchivó rol #${id}`, severity: 'info' });
  return res.sendStatus(200);
});
