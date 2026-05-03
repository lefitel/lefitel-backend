import { Request, Response } from "express";
import { Op } from "sequelize";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";

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
  if (req.user?.id_rol !== 1) {
    return res.status(403).json({ message: "No tienes permiso para crear usuarios." });
  }
  try {
    req.body.pass = await bcryptjs.hash(req.body.pass, 8);

    const TempUsuario = await UsuarioModel.create(req.body);
    logAction({ id_usuario: req.user?.id, action: "CREATE_USUARIO", entity: "Usuario", entity_id: TempUsuario.dataValues.id as number, detail: `Creó usuario @${req.body.user}`, metadata: { after: { user: req.body.user } }, severity: 'info' });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateUsuario(req: Request, res: Response) {
  const { id } = req.params;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  if (loggedUser && loggedUser.id !== Number(id) && loggedUser.id_rol !== 1) {
    return res.status(403).json({ message: "No tienes permiso para modificar la información de este usuario." });
  }

  try {
    const TempUsuario = await UsuarioModel.findOne({ where: { id } });
    if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });
    const oldImage = TempUsuario.dataValues.image;
    const udv = TempUsuario.dataValues as unknown as Record<string, unknown>;
    const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
    const beforeMeta: Record<string, unknown> = {};
    const afterMeta:  Record<string, unknown> = {};
    for (const k of Object.keys(req.body)) {
      const bv = udv[k];
      if (bv === undefined || k === "id_rol") continue;
      if (isPrimVal(bv) && isPrimVal(req.body[k])) { beforeMeta[k] = bv; afterMeta[k] = req.body[k]; }
    }
    const bvRol = udv["id_rol"] as number | null | undefined;
    const avRol = req.body["id_rol"] as number | null | undefined;
    if (bvRol !== undefined && bvRol !== avRol) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fkRef = async (pkVal: number | null | undefined) => {
        if (pkVal == null) return null;
        const row = await (RolModel as any).findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
        return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
      };
      [beforeMeta["id_rol"], afterMeta["id_rol"]] = await Promise.all([fkRef(bvRol), fkRef(avRol)]);
    }
    TempUsuario.set(req.body);
    await TempUsuario.save();
    if (oldImage && req.body.image && oldImage !== req.body.image) {
      deleteImageFile(oldImage);
    }
    logAction({ id_usuario: req.user?.id, action: "UPDATE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Editó perfil del usuario #${id}`, metadata: { before: beforeMeta, after: afterMeta }, severity: 'warning' });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateUserName(req: Request, res: Response) {
  const { id } = req.params;
  const { user } = req.body;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  if (loggedUser && loggedUser.id !== Number(id) && loggedUser.id_rol !== 1) {
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
    TempUsuario.set({ ...TempUsuario, user: user });
    await TempUsuario.save();
    logAction({ id_usuario: req.user?.id, action: "CHANGE_USERNAME", entity: "Usuario", entity_id: Number(id), detail: `Cambió nombre de usuario a @${user}`, metadata: { before: { user: oldUser }, after: { user } }, severity: 'warning', ip_address: req.ip ?? null });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateUserPass(req: Request, res: Response) {
  const { id } = req.params;
  const { pass, oldPass } = req.body;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  if (loggedUser && loggedUser.id !== Number(id) && loggedUser.id_rol !== 1) {
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
    } else if (loggedUser.id_rol !== 1) {
        // Obligatorio para no administradores
       return res.status(400).json({ message: "Debe proporcionar su contraseña actual." });
    }

    const hashedPass = await bcryptjs.hash(pass, 8);
    TempUsuario.set({ ...TempUsuario, pass: hashedPass });
    await TempUsuario.save();
    const isSelf = req.user?.id === Number(id);
    logAction({ id_usuario: req.user?.id, action: "CHANGE_PASSWORD", entity: "Usuario", entity_id: Number(id), detail: isSelf ? "Cambió su contraseña" : `Cambió contraseña del usuario #${id}`, metadata: { target_user_id: Number(id), self: isSelf }, severity: 'critical', ip_address: req.ip ?? null });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteUsuario(req: Request, res: Response) {
  const { id } = req.params;
  if (req.user?.id_rol !== 1) {
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
  if (req.user?.id_rol !== 1) {
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
