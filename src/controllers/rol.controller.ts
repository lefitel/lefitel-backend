import { NextFunction, Request, Response } from "express";
import { Op, col, fn, where as donde } from "sequelize";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { logAction } from "../utils/logAction.js";
import { desarchivar, NADA_QUE_DESARCHIVAR } from "../utils/archivado.js";
import { seedRolePermissions } from "../permissions/store.js";
import { assignable } from "../utils/authorship.js";
import { leerNombre } from "../utils/nombre.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const rolLog = log("rol");
const handler = makeHandler(rolLog);

/** A role's name as it will be stored, or why it is refused. See `leerNombre`. */
const nombreDeRol = (body: unknown, required: boolean) =>
  leerNombre(body, required, "El rol necesita un nombre.");

/**
 * The same refusal, in front of the password.
 *
 * Both writes sit behind the step-up gate, and the gate runs before the
 * handler. Checked only in the handler, a request with no name was answered
 * "confirm it is you", the person typed their password — a wrong one charged
 * to their attempts — and only then was told the request could never have
 * worked. The route puts this between the permission and the gate; the handler
 * still checks, because it is the handler that writes.
 */
export const exigirNombreDeRol = (required: boolean) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const resultado = nombreDeRol(req.body, required);
    if ("error" in resultado) return res.status(400).json({ message: resultado.error });
    // An edit is compared against every role but itself: saving a role under
    // the name it already has is not a clash.
    const propio = required ? undefined : Number(req.params.id);
    if (resultado.name !== undefined && await nombreEnUso(resultado.name, propio)) {
      return res.status(409).json({ message: yaExiste(resultado.name) });
    }
    return next();
  };

/**
 * Whether an active role, other than `exceptoId`, already goes by this name.
 *
 * Nothing stopped two roles from being called the same, and two roles called
 * "Supervisor" cannot be told apart in the one place it matters — the picker
 * that hands a role to an account — while a report filtered by role name
 * quietly merges them. Compared without regard to case, because "supervisor"
 * and "Supervisor" are the same word to whoever is choosing between them.
 *
 * Only active roles count. An archived one keeps its name and gets in nobody's
 * way; the clash is caught when it is brought back — see `desarchivarRol`.
 *
 * 🔴 **A check, not a guarantee.** Two requests arriving together can both pass
 * it. Closing that takes a unique index on `lower(name)` among the rows that
 * are not archived, which is a migration that fails on a database already
 * holding a pair — and nobody has looked at production for one. Until that is
 * measured and decided, this is what stands between a person and the mistake,
 * which is the case that actually happens.
 */
async function nombreEnUso(name: string, exceptoId?: number): Promise<boolean> {
  const iguales = await RolModel.count({
    where: {
      [Op.and]: [
        donde(fn("lower", col("name")), name.toLowerCase()),
        ...(exceptoId === undefined || Number.isNaN(exceptoId) ? [] : [{ id: { [Op.ne]: exceptoId } }]),
      ],
    },
  });
  return iguales > 0;
}

const yaExiste = (name: string) => `Ya existe un rol llamado «${name}». Elige otro nombre.`;

/**
 * The same clash, caught by the database instead of by the check above.
 *
 * `20261010000003-unique-rol-name.ts` holds the rule for the case the check
 * cannot: two requests that both looked, both found the name free, and both
 * wrote. The second one fails there, and without this it would be answered
 * "Ya existe un registro con esos datos." — true, and no help in finding which.
 */
const chocaConOtroRol = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "SequelizeUniqueConstraintError";

/**
 * How many accounts hold each of these roles: all of them, and the archived
 * ones among them.
 *
 * **Archived accounts count.** An archived account still points at its role,
 * and it comes back with one press. Counting only the active ones let a role
 * be archived while archived accounts held it, and restoring one of those left
 * exactly what `deleteRol` exists to prevent: a live account on an archived
 * role, keeping permissions no screen can show or change. So the listing and
 * the guard both read from here, and cannot come to disagree.
 */
async function cuentasPorRol(ids: number[]): Promise<Map<number, { total: number; archivadas: number }>> {
  const porRol = new Map<number, { total: number; archivadas: number }>();
  if (ids.length === 0) return porRol;
  type Grupo = { id_rol: number; count: number | string };
  const [todas, activas] = await Promise.all([
    UsuarioModel.count({ where: { id_rol: ids }, group: ["id_rol"], paranoid: false }),
    UsuarioModel.count({ where: { id_rol: ids }, group: ["id_rol"] }),
  ]) as unknown as [Grupo[], Grupo[]];
  const vivas = new Map(activas.map((g) => [Number(g.id_rol), Number(g.count)]));
  for (const g of todas) {
    const total = Number(g.count);
    porRol.set(Number(g.id_rol), { total, archivadas: total - (vivas.get(Number(g.id_rol)) ?? 0) });
  }
  return porRol;
}

export const getRol = handler("getRol", async (req: Request, res: Response) => {
  // `?archived=true` lists the archived ones instead, the same shape every other
  // manageable entity here uses. The route asks for `roles.ver`, and has to: this
  // answers with how many accounts hold each role, not only with names.
  const isArchived = req.query.archived === "true";
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const listado = await listar(RolModel, {
    where: isArchived ? { deletedAt: { [Op.ne]: null } } : undefined,
    paranoid: !isArchived,
    order: [["id", "DESC"]],
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

  // How many accounts hold each role, beside the role. The screen that lists
  // them shows it, because it is what decides whether a role can be archived:
  // `deleteRol` below refuses while the number is not zero, and an
  // administrator should see that before pressing, not learn it from a 409.
  // Grouped queries for the whole page, not one per role.
  const porRol = await cuentasPorRol(listado.data.map((rol) => rol.dataValues.id as number));
  return res.status(200).json({
    ...listado,
    data: listado.data.map((rol) => {
      const cuentas = porRol.get(rol.dataValues.id as number);
      return {
        ...rol.toJSON(),
        cuentas: cuentas?.total ?? 0,
        cuentasArchivadas: cuentas?.archivadas ?? 0,
      };
    }),
  });
});

export const createRol = handler("createRol", async (req: Request, res: Response) => {
  const nombre = nombreDeRol(req.body, true);
  if ("error" in nombre) return res.status(400).json({ message: nombre.error });
  if (nombre.name !== undefined && await nombreEnUso(nombre.name)) {
    return res.status(409).json({ message: yaExiste(nombre.name) });
  }

  let TempRol;
  try {
    TempRol = await RolModel.create({ ...assignable(req.body), name: nombre.name });
  } catch (error) {
    if (chocaConOtroRol(error) && nombre.name !== undefined) return res.status(409).json({ message: yaExiste(nombre.name) });
    throw error;
  }
  // A role with no rows in `permisos` has no checkboxes on the roles
  // screen: the administrator would be looking at an empty form with no way
  // to grant anything, and the account would be able to do nothing for ever.
  // Every cell starts denied, which is both safe and editable.
  await seedRolePermissions(TempRol.dataValues.id as number);
  logAction({ id_usuario: req.user?.id, action: "CREATE_ROL", entity: "Rol", entity_id: TempRol.dataValues.id as number, detail: `Creó rol "${nombre.name}"`, metadata: { after: { name: nombre.name } }, severity: 'info' });
  res.status(201).json(TempRol);
});

export const updateRol = handler("updateRol", async (req: Request, res: Response) => {
  const { id } = req.params;

  const nombre = nombreDeRol(req.body, false);
  if ("error" in nombre) return res.status(400).json({ message: nombre.error });
  if (nombre.name !== undefined && await nombreEnUso(nombre.name, Number(id))) {
    return res.status(409).json({ message: yaExiste(nombre.name) });
  }

  const TempRol = await RolModel.findOne({ where: { id } });
  if (!TempRol) return res.status(404).json({ message: "Rol no encontrado" });
  const dv = TempRol.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written, not from the body as
  // received. With `after: req.body`, a PUT carrying `deletedAt` archived nothing
  // and still wrote into the bitácora that it had — the defect A0 closed in the
  // other eight controllers while this file belonged to another session.
  const editable: Record<string, unknown> = assignable(req.body);
  if (nombre.name !== undefined) editable.name = nombre.name;
  const beforeRol = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempRol.set(editable);
  try {
    await TempRol.save();
  } catch (error) {
    if (chocaConOtroRol(error) && nombre.name !== undefined) return res.status(409).json({ message: yaExiste(nombre.name) });
    throw error;
  }
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
 * the role vanishes from every list, and the roles screen can no longer show
 * or change what they may do.
 *
 * "Has accounts" includes archived ones — see `cuentasPorRol`. The refusal
 * says how many of them are, because those are the ones the administrator
 * will not find in the list they are looking at.
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

  const cuentas = (await cuentasPorRol([Number(id)])).get(Number(id));
  const enUso = cuentas?.total ?? 0;
  if (enUso > 0) {
    const archivadas = cuentas?.archivadas ?? 0;
    const deEllas = archivadas === 0 ? ""
      : enUso === 1 ? ", archivada"
      : archivadas === enUso ? ", todas archivadas"
      : archivadas === 1 ? ", 1 de ellas archivada"
      : `, ${archivadas} de ellas archivadas`;
    return res.status(409).json({
      message: enUso === 1
        ? `No se puede archivar: hay 1 cuenta con este rol${deEllas}. Cámbiale el rol antes de archivarlo.`
        : `No se puede archivar: hay ${enUso} cuentas con este rol${deEllas}. Cámbiales el rol antes de archivarlo.`,
      cuentas: enUso,
    });
  }

  await rol.destroy();
  logAction({ id_usuario: req.user?.id, action: "DELETE_ROL", entity: "Rol", entity_id: Number(id), detail: `Archivó rol #${id}`, severity: 'critical' });
  return res.status(204).end();
});

export const desarchivarRol = handler("desarchivarRol", async (req: Request, res: Response) => {
  const { id } = req.params;

  // A role that comes back takes its name back with it, and somebody may have
  // given that name to another role in the meantime. Refused rather than
  // restored into a pair: the archived one cannot be renamed while archived,
  // so the sentence says which of the two to rename.
  const archivado = await RolModel.findOne({ where: { id }, paranoid: false, attributes: ["id", "name", "deletedAt"] });
  const suNombre: unknown = archivado?.get("name");
  if (archivado?.get("deletedAt") != null && typeof suNombre === "string" && await nombreEnUso(suNombre, Number(id))) {
    return res.status(409).json({
      message: `No se puede desarchivar: ya hay un rol activo llamado «${suNombre}». Cámbiale el nombre a ese y vuelve a intentarlo.`,
    });
  }

  if (!(await desarchivar(RolModel, id))) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_ROL", entity: "Rol", entity_id: Number(id), detail: `Desarchivó rol #${id}`, severity: 'info' });
  return res.status(204).end();
});
