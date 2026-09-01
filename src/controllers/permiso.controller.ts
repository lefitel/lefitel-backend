import { Request, Response } from "express";
import { sequelize } from "../database/sequelize.js";
import { PermisoModel } from "../models/permiso.model.js";
import { RolModel } from "../models/rol.model.js";
import { logAction } from "../utils/logAction.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const permisoLog = log("permiso");
const handler = makeHandler(permisoLog);
import {
  ACTIONS,
  ACTION_LABELS,
  MODULES,
  MODULE_LABELS,
  actionsOf,
  isAction,
  isActionOf,
  isModule,
} from "../permissions/matrix.js";
import { allPermissions, invalidatePermissions, permissionsFor } from "../permissions/store.js";

/**
 * The permission matrix as the Seguridad screen needs it: the roles, the
 * vocabulary, and every cell.
 *
 * The vocabulary travels with the data on purpose. The screen draws a column per
 * action and a row per module, and if it kept its own list the day somebody adds
 * a module the screen would quietly stop offering it — which is the drift this
 * whole change exists to end.
 */
export const getPermisos = handler("getPermisos", async (_req: Request, res: Response) => {
  const roles = await RolModel.findAll({
    attributes: ["id", "name", "description"],
    order: [["id", "ASC"]],
  });
  res.status(200).json({
    roles,
    // `acciones` per module is the new half; the flat list stays as the
    // dictionary of labels, and staying is not politeness. The frontend is a
    // PWA registered with `registerType: "prompt"`, so a bundle that predates
    // this deploy can sit in a tab for days, and `web/src` has no
    // ErrorBoundary anywhere — a `PermisosPanel` that mapped over a missing
    // `acciones` would blank the whole application, not the panel. Additive,
    // the old bundle keeps drawing its full grid; a cell it offers that no
    // longer exists is refused by name in `changesFrom`.
    modulos: MODULES.map((key) => ({
      key,
      label: MODULE_LABELS[key],
      acciones: actionsOf(key),
    })),
    acciones: ACTIONS.map((key) => ({ key, label: ACTION_LABELS[key] })),
    permisos: await allPermissions(),
  });
});

/** One cell as the request names it, once it has been checked. */
interface Change {
  modulo: string;
  accion: string;
  permitido: boolean;
}

/**
 * Read the requested cells out of a request body, refusing anything unrecognised.
 *
 * Accepting a module name the code does not know would write a row that grants
 * nothing and shows nowhere — a permission that appears to have been given and
 * has not.
 */
function changesFrom(body: unknown): Change[] | { error: string } {
  const source = (body as { permisos?: unknown } | undefined)?.permisos;
  if (!source || typeof source !== "object") {
    return { error: "Falta el cuerpo con los permisos a guardar." };
  }

  const changes: Change[] = [];
  for (const [modulo, actions] of Object.entries(source as Record<string, unknown>)) {
    if (!isModule(modulo)) return { error: `El módulo "${modulo}" no existe.` };
    if (!actions || typeof actions !== "object") {
      return { error: `El módulo "${modulo}" no trae acciones.` };
    }
    for (const [accion, permitido] of Object.entries(actions as Record<string, unknown>)) {
      if (!isAction(accion)) return { error: `La acción "${accion}" no existe.` };
      // The pair, and it is a separate check from the one above on purpose.
      // `bitacora` is a module and `archivar` is an action, so checking each
      // half in turn accepts a combination that does not exist — the row gets
      // written, nothing reads it, and it starts granting the day that module
      // gains that action. Naming both halves in the message matters too: an
      // administrator looking at a screen with `archivar` on it would not
      // believe "la acción archivar no existe".
      if (!isActionOf(modulo, accion)) {
        return { error: `El módulo "${modulo}" no tiene la acción "${accion}".` };
      }
      if (typeof permitido !== "boolean") {
        return { error: `"${modulo}.${accion}" debe ser verdadero o falso.` };
      }
      changes.push({ modulo, accion, permitido });
    }
  }
  return changes;
}

/**
 * Save what a role may do.
 *
 * Refuses to let the caller edit their own role. Not paranoia: the screen's
 * whole purpose is granting authority, and the one mistake with no way back is
 * taking away your own — an administrator who unticks Roles cannot tick it
 * again, and nobody else can either. Editing another administrator's role still
 * works, so the escape hatch stays open as long as there are two of them.
 */
export const putPermisos = handler("putPermisos", async (req: Request, res: Response) => {
  const id_rol = Number(req.params.id_rol);
  if (!Number.isInteger(id_rol)) {
    return res.status(400).json({ message: "Rol no válido." });
  }
  if (req.user?.id_rol === id_rol) {
    return res.status(409).json({
      message: "No puede cambiar los permisos de su propio rol. Pídaselo a otro administrador.",
    });
  }

  const changes = changesFrom(req.body);
  if (!Array.isArray(changes)) return res.status(400).json({ message: changes.error });
  if (changes.length === 0) return res.status(400).json({ message: "No hay nada que guardar." });

  const rol = await RolModel.findByPk(id_rol, { attributes: ["id", "name"] });
  if (!rol) return res.status(404).json({ message: "Rol no encontrado" });

  const before = await permissionsFor(id_rol);
  // Only what actually moves goes to the database and to the audit log. A
  // screen that sends its whole state on every save would otherwise write
  // thirty-two rows and log "changed permissions" for a single tick.
  const moved = changes.filter((c) => before[c.modulo][c.accion] !== c.permitido);
  if (moved.length === 0) {
    return res.status(200).json({ permisos: before, message: "Sin cambios." });
  }

  // Written one cell at a time, in a transaction, rather than as an upsert.
  // An upsert here would lean on Sequelize inferring the right conflict target
  // from the unique index; spelling out update-then-insert costs nothing at
  // this size and cannot silently write the wrong row. The insert covers a
  // role whose rows predate the module being added.
  await sequelize.transaction(async (transaction) => {
    for (const c of moved) {
      const [updated] = await PermisoModel.update(
        { permitido: c.permitido },
        { where: { id_rol, modulo: c.modulo, accion: c.accion }, transaction },
      );
      if (updated === 0) {
        await PermisoModel.create(
          { id_rol, modulo: c.modulo, accion: c.accion, permitido: c.permitido },
          { transaction },
        );
      }
    }
  });
  invalidatePermissions();

  logAction({
    id_usuario: req.user?.id,
    action: "UPDATE_PERMISOS",
    entity: "Rol",
    entity_id: id_rol,
    detail: `Cambió ${moved.length} permiso(s) del rol "${rol.dataValues.name}"`,
    metadata: {
      rol: rol.dataValues.name,
      cambios: moved.map((c) => `${c.modulo}.${c.accion}: ${c.permitido ? "sí" : "no"}`),
    },
    severity: "critical",
    ip_address: req.ip ?? null,
  });

  res.status(200).json({ permisos: await permissionsFor(id_rol) });
});
