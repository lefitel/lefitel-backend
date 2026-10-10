// Which role an account already has, as a resource of its own.
//
// **Why it is not a field of `PUT /api/usuario/:id` any more.** That route
// carried `id_rol` in its allowlist, so one request could edit a profile and
// hand out authority at the same time. It is also the route a person edits
// their *own* profile through, and it is joining the ten-minute
// reauthentication window for that reason — saving a telephone number must not
// ask for a password again. Leaving the role in it would mean one request,
// inside somebody else's open window, turning whoever holds the cookie into an
// administrator **with their own credentials**: a promotion that survives the
// victim changing their password, `logout-all`, a factor reset and the console
// rescue, because none of those touch the attacker's account. So the field
// moved out rather than the route staying out.
//
// **Since the decision of 2026-10-10 this route takes the window too**, so the
// promotion above is possible inside one: it used to ask for the caller's
// password on every request and no longer does. An accepted cost, with the risk
// put to Isaias twice; the split still keeps the field off the route a person
// edits their own profile through.
//
// This handler is therefore the only place in the API that writes the `id_rol`
// of an account that already exists. `createUsuario` still sets one — an
// account cannot be born without a role — and `POST /api/usuario/` takes the
// window exactly as this route does.
//
// What is *not* here: the permission that decides who may call this. The route
// asks for `roles.editar` (`usuario.routes.ts`) and so does the first check
// below, deliberately twice, the way `createUsuario` and `desbloquearUsuario`
// already do — the rule travels with the handler instead of with wherever
// somebody happens to mount it.

import type { Request, Response } from "express";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { can } from "../permissions/store.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const usuarioRolLog = log("usuarioRol");
const handler = makeHandler(usuarioRolLog);

/**
 * A role as the audit log names it, or `null` when the account had none on
 * file.
 *
 * `paranoid: false` on purpose: the role somebody is being moved *away* from
 * may have been archived since it was assigned, and an audit line that says
 * "from (nothing)" because the row is soft-deleted describes a change that did
 * not happen. The same reading `updateUsuario` used while it still wrote this
 * column.
 */
async function rolParaLaBitacora(id: number | null | undefined) {
  if (id == null) return null;
  const row = await RolModel.findByPk(id, { attributes: ["id", "name"], paranoid: false });
  return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
}

/**
 * `PUT /api/usuario/:id/rol` — move one account to another role.
 *
 * Answers `204`: the only thing this writes is the number the caller just
 * sent, so there is nothing to send back. Its nearest neighbour,
 * `PATCH /api/usuario/:id/desbloquear`, answers the same for the same reason.
 *
 * 🔴 **A client must never call this with the caller's own row, not even with
 * the role unchanged: the refusal below is unconditional and answers 403.** A
 * screen that posts the role alongside every profile save — the shape
 * `PUT /api/usuario/:id` deliberately tolerates, because the profile page
 * echoes `id_rol` back untouched — would therefore break saving your own
 * account. Send this only when the role actually moved and the target is
 * somebody else.
 */
export const asignarRol = handler("asignarRol", async (req: Request, res: Response) => {
  const loggedUser = req.user;

  if (!(await can(loggedUser?.id_rol, "roles", "editar"))) {
    return res.status(403).json({ message: "No tienes permiso para asignar roles." });
  }

  const objetivo = Number(req.params.id);
  if (!Number.isInteger(objetivo)) {
    return res.status(400).json({ message: "Usuario no válido." });
  }

  /**
   * `putPermisos`'s refusal, applied to the account instead of the role, and
   * unconditional here where that one is too: the one mistake with no way back
   * is taking away your own access, and nobody else can hand it back to you.
   *
   * Unlike the check this replaces in `updateUsuario`, it does not first ask
   * whether the role is actually moving. That one had to, because the profile
   * page echoes `id_rol` back untouched on every save and refusing it would
   * have broken saving your own name. This route has no such traffic: asking it
   * for anything at all is asking to change a role, so a request aimed at
   * yourself is the thing being refused whatever number it carries.
   */
  if (loggedUser && loggedUser.id === objetivo) {
    return res.status(403).json({
      message: "No puede cambiar su propio rol. Pídaselo a otro administrador.",
    });
  }

  const enviado = (req.body as Record<string, unknown> | undefined)?.id_rol;
  // `Number()` alone is not a check: it reads `null`, `""` and `[]` as zero, so
  // a body that names no role would ask for role 0 rather than being refused.
  const nuevoRol =
    typeof enviado === "number"
      ? enviado
      : typeof enviado === "string" && enviado.trim() !== ""
        ? Number(enviado)
        : NaN;
  if (!Number.isInteger(nuevoRol)) {
    return res.status(400).json({ message: "Rol no válido." });
  }

  // `UsuarioModel` is paranoid, so an archived account is not found here and
  // answers 404 — which is what should happen: restoring it is what comes
  // first, and `PATCH /:id/restore` is the route for that.
  const usuario = await UsuarioModel.findByPk(objetivo);
  if (!usuario) return res.status(404).json({ message: "Usuario no encontrado" });

  // Read with the archived rows included so the two answers can be told apart:
  // a role that never existed is the caller's mistake, and one that was
  // archived is a role picker showing something the Roles screen retired.
  const rol = await RolModel.findByPk(nuevoRol, {
    attributes: ["id", "name", "deletedAt"],
    paranoid: false,
  });
  if (!rol) return res.status(404).json({ message: "Rol no encontrado" });
  if (rol.dataValues.deletedAt) {
    return res.status(409).json({ message: "No se puede asignar un rol archivado." });
  }

  const rolAnterior = usuario.dataValues.id_rol;
  // Nothing to write, so nothing to record. `putPermisos` answers the same way
  // to a save that moves nothing: an audit log with a line saying a role
  // changed from 3 to 3 is a log that is harder to read afterwards.
  if (rolAnterior === nuevoRol) return res.status(204).end();

  usuario.set({ id_rol: nuevoRol });
  await usuario.save();

  const [antes, despues] = await Promise.all([
    rolParaLaBitacora(rolAnterior),
    rolParaLaBitacora(nuevoRol),
  ]);
  // The same `before`/`after` shape `updateUsuario` wrote while the role was
  // still one of its fields, so the bitácora screen renders this change the way
  // it already rendered it.
  logAction({
    id_usuario: loggedUser?.id,
    action: "ROLE_ASSIGNED",
    entity: "Usuario",
    entity_id: objetivo,
    detail: `Cambió el rol del usuario #${objetivo}`,
    metadata: { before: { id_rol: antes }, after: { id_rol: despues } },
    severity: "warning",
    ip_address: req.ip ?? null,
  });

  return res.status(204).end();
});
