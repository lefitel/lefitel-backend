import { Request, Response } from "express";
import { Op } from "sequelize";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { can } from "../permissions/store.js";

export async function getUsuario(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempUsuario = await UsuarioModel.findAll({
      order: [["id", "DESC"]],
      attributes: { exclude: ["pass"] },
      include: [{ model: RolModel }],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempUsuario);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    return res.status(500).json({ message: msg });
  }
}
export async function searchUsuario(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempUsuario = await UsuarioModel.findOne({
      where: { id },
      attributes: { exclude: ["pass"] },
      include: [{ model: RolModel }],
    });
    res.status(200).json(TempUsuario);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    return res.status(500).json({ message: msg });
  }
}

export async function searchUsuario_user(req: Request, res: Response) {
  const { user } = req.params;
  try {
    const TempUsuario = await UsuarioModel.findOne({
      where: { user },
      attributes: { exclude: ["pass"] },
    });
    if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });
    res.status(200).json(TempUsuario);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    return res.status(500).json({ message: msg });
  }
}

export async function createUsuario(req: Request, res: Response) {
  // The route already asks the same question. Asked again here so the rule
  // travels with the handler rather than with wherever it happens to be mounted.
  if (!(await can(req.user?.id_rol, "seguridad", "crear"))) {
    return res.status(403).json({ message: "No tienes permiso para crear usuarios." });
  }
  try {
    // Trimmed on the way in, not only on the way out. An account stored as
    // " Diego " can never be logged into: the person types "Diego" and the
    // lookup does not match, and nothing on screen explains why.
    if (typeof req.body?.user === "string") req.body.user = req.body.user.trim();
    req.body.pass = await bcryptjs.hash(req.body.pass, 8);

    const TempUsuario = await UsuarioModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_USUARIO", entity: "Usuario", entity_id: TempUsuario.dataValues.id as number, detail: `Creó usuario @${req.body.user}`, metadata: { after: { user: req.body.user } }, severity: 'info' });
    res.status(200).json(withoutPass(TempUsuario));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
/**
 * The fields a request may change about a user through `PUT /usuario/:id`.
 *
 * This handler used to hand `req.body` straight to `TempUsuario.set()`, and the
 * route deliberately lets a person edit their own record — so any authenticated
 * account could PUT `{ id_rol: 1 }` at its own id and come back an
 * administrator. Username and password each have their own endpoint with their
 * own checks, and `id` is not something a request gets to choose.
 */
const EDITABLE_FIELDS = ["name", "lastname", "birthday", "image", "phone"] as const;

/** Needs the Roles module, not merely the right to edit the account. */
const ROLE_ASSIGNMENT_FIELDS = ["id_rol"] as const;

function editableFrom(body: unknown, mayAssignRoles: boolean): Record<string, unknown> {
  const source = (body ?? {}) as Record<string, unknown>;
  const allowed: readonly string[] = mayAssignRoles
    ? [...EDITABLE_FIELDS, ...ROLE_ASSIGNMENT_FIELDS]
    : EDITABLE_FIELDS;

  const patch: Record<string, unknown> = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, field)) patch[field] = source[field];
  }
  return patch;
}

/** The record as it may leave the server: everything except the hash. */
function withoutPass(instance: { toJSON(): unknown }): Record<string, unknown> {
  const plain = { ...(instance.toJSON() as Record<string, unknown>) };
  delete plain.pass;
  return plain;
}

export async function updateUsuario(req: Request, res: Response) {
  const { id } = req.params;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  const mayManageUsers = await can(loggedUser?.id_rol, "seguridad", "editar");
  if (!loggedUser || (loggedUser.id !== Number(id) && !mayManageUsers)) {
    return res.status(403).json({ message: "No tienes permiso para modificar la información de este usuario." });
  }

  // Assigning a role is a separate power from editing an account, and lives in
  // its own module. Otherwise granting somebody the right to fix a colleague's
  // telephone number would also let them promote themselves.
  const mayAssignRoles = await can(loggedUser.id_rol, "roles", "editar");

  try {
    const TempUsuario = await UsuarioModel.findOne({ where: { id } });
    if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });

    // The profile page sends the whole user object back, its own role included,
    // so an unchanged id_rol from a non-administrator is ordinary traffic and is
    // simply dropped by the allowlist. Asking for a *different* one is an
    // escalation attempt, and that earns a refusal and a line in the bitácora.
    const requestedRol = (req.body as Record<string, unknown> | undefined)?.id_rol;
    if (!mayAssignRoles && requestedRol !== undefined && Number(requestedRol) !== TempUsuario.dataValues.id_rol) {
      logAction({ id_usuario: loggedUser.id, action: "ROLE_CHANGE_DENIED", entity: "Usuario", entity_id: Number(id), detail: `Intentó cambiar el rol del usuario #${id} sin permiso sobre Roles`, metadata: { from: TempUsuario.dataValues.id_rol, requested: requestedRol }, severity: 'critical', ip_address: req.ip ?? null });
      return res.status(403).json({ message: "Solo un administrador puede cambiar el rol de un usuario." });
    }

    const patch = editableFrom(req.body, mayAssignRoles);
    const oldImage = TempUsuario.dataValues.image;
    const udv = TempUsuario.dataValues as unknown as Record<string, unknown>;
    const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
    const beforeMeta: Record<string, unknown> = {};
    const afterMeta:  Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      const bv = udv[k];
      if (bv === undefined || k === "id_rol") continue;
      if (isPrimVal(bv) && isPrimVal(patch[k])) { beforeMeta[k] = bv; afterMeta[k] = patch[k]; }
    }
    const bvRol = udv["id_rol"] as number | null | undefined;
    const avRol = patch["id_rol"] as number | null | undefined;
    // Only when the role is actually part of the write. Reading it off the raw
    // body meant a request that never mentioned id_rol still logged a change
    // "to null".
    if ("id_rol" in patch && bvRol !== avRol) {
      const fkRef = async (pkVal: number | null | undefined) => {
        if (pkVal == null) return null;
        const row = await RolModel.findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
        return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
      };
      [beforeMeta["id_rol"], afterMeta["id_rol"]] = await Promise.all([fkRef(bvRol), fkRef(avRol)]);
    }
    TempUsuario.set(patch);
    await TempUsuario.save();
    if (oldImage && patch.image && oldImage !== patch.image) {
      deleteImageFile(oldImage);
    }
    logAction({ id_usuario: req.user?.id, action: "UPDATE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Editó perfil del usuario #${id}`, metadata: { before: beforeMeta, after: afterMeta }, severity: 'warning' });
    res.status(200).json(withoutPass(TempUsuario));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateUserName(req: Request, res: Response) {
  const { id } = req.params;
  const user = typeof req.body?.user === "string" ? req.body.user.trim() : req.body?.user;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  if (!loggedUser || (loggedUser.id !== Number(id) && !(await can(loggedUser?.id_rol, "seguridad", "editar")))) {
    return res.status(403).json({ message: "No tienes permiso para editar este usuario." });
  }

  try {
    // Validación de Unicidad
    const existingUser = await UsuarioModel.findOne({ where: { user } });
    if (existingUser && existingUser.dataValues.id !== Number(id)) {
      return res.status(409).json({ message: "El nombre de usuario ya está tomado por otra persona." });
    }

    const TempUsuario = await UsuarioModel.findOne({
      where: { id },
    });
    if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });
    const oldUser = TempUsuario.dataValues.user;
    TempUsuario.set({ user });
    await TempUsuario.save();
    logAction({ id_usuario: req.user?.id, action: "CHANGE_USERNAME", entity: "Usuario", entity_id: Number(id), detail: `Cambió nombre de usuario a @${user}`, metadata: { before: { user: oldUser }, after: { user } }, severity: 'warning', ip_address: req.ip ?? null });
    res.status(200).json(withoutPass(TempUsuario));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateUserPass(req: Request, res: Response) {
  const { id } = req.params;
  const { pass, oldPass } = req.body;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  const mayResetPasswords = await can(loggedUser?.id_rol, "seguridad", "editar");
  if (!loggedUser || (loggedUser.id !== Number(id) && !mayResetPasswords)) {
    return res.status(403).json({ message: "No tienes permiso para editar la contraseña de este usuario." });
  }

  try {
    const TempUsuario = await UsuarioModel.findOne({
      where: { id },
    });
    if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });

    // Validate oldPass
    if (oldPass) {
       const isMatch = await bcryptjs.compare(oldPass, TempUsuario.dataValues.pass);
       if (!isMatch) {
         return res.status(401).json({ message: "La contraseña actual suministrada no es correcta." });
       }
    } else if (!mayResetPasswords) {
        // Whoever cannot manage accounts must prove they know the current one
       return res.status(400).json({ message: "Debe proporcionar su contraseña actual." });
    }

    const hashedPass = await bcryptjs.hash(pass, 8);
    TempUsuario.set({ pass: hashedPass });
    await TempUsuario.save();
    const isSelf = req.user?.id === Number(id);
    logAction({ id_usuario: req.user?.id, action: "CHANGE_PASSWORD", entity: "Usuario", entity_id: Number(id), detail: isSelf ? "Cambió su contraseña" : `Cambió contraseña del usuario #${id}`, metadata: { target_user_id: Number(id), self: isSelf }, severity: 'critical', ip_address: req.ip ?? null });
    res.status(200).json(withoutPass(TempUsuario));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteUsuario(req: Request, res: Response) {
  const { id } = req.params;
  if (!(await can(req.user?.id_rol, "seguridad", "archivar"))) {
    return res.status(403).json({ message: "No tienes permiso para eliminar usuarios." });
  }
  try {
    await UsuarioModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Archivó usuario #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarUsuario(req: Request, res: Response) {
  const { id } = req.params;
  if (!(await can(req.user?.id_rol, "seguridad", "archivar"))) {
    return res.status(403).json({ message: "No tienes permiso para restaurar usuarios." });
  }
  try {
    await UsuarioModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Desarchivó usuario #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
