import { Request, Response } from "express";
import { Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import bcryptjs from "bcryptjs";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { can } from "../permissions/store.js";
import { BCRYPT_COST } from "../config/security.js";
import { validarPassword } from "../utils/password.js";
import { whereUsernameIs } from "../utils/username.js";

/** Shared text: whichever endpoint hit this, the fix is the same username. */
const USERNAME_TAKEN_MESSAGE = "El nombre de usuario ya está tomado por otra persona.";

/**
 * Whether some other living account already holds this username.
 *
 * Case-insensitive and scoped to non-archived rows, matching
 * `usuarios_user_uniq` exactly: `UsuarioModel` is paranoid, so a plain
 * `findOne` already excludes soft-deleted rows the same way the partial
 * index does. One function instead of three copies of the same query, so
 * creating an account, restoring one, and renaming one can never drift out
 * of sync with what the database actually enforces.
 */
async function nombreEnUso(user: string, exceptoId?: number): Promise<boolean> {
  const existing = await UsuarioModel.findOne({
    where: whereUsernameIs(user),
    attributes: ["id"],
  });
  if (!existing) return false;
  return exceptoId === undefined || existing.dataValues.id !== exceptoId;
}

/**
 * `nombreEnUso`'s signature promises a string, but nothing upstream
 * guarantees one: there is no body validation on this route
 * (`usuario.routes.ts` only checks permissions), and `tsconfig.json` has
 * `strict: false`, so the type annotation catches nothing at compile time.
 * `user.toLowerCase()` would throw on anything else and turn into a 500.
 *
 * Rejecting rather than coercing with `String(user)`: `POST /usuario
 * { "user": 123 }` used to create the account "123" — the write went
 * through the type conversion Postgres's `varchar` column did for it,
 * silently. A number where a username belongs was already a bad request;
 * this makes the server say so instead of agreeing with it.
 */
function requireUsernameString(user: unknown): user is string {
  return typeof user === "string";
}

const USERNAME_NOT_STRING_MESSAGE = "El nombre de usuario debe ser un texto.";

/**
 * True for a Postgres unique-violation on `usuarios_user_uniq` specifically.
 *
 * `nombreEnUso` closes the collision for an ordinary request, but not the
 * race between two requests that both read "free" a moment apart — the
 * database is still the one honest answer for that. This only stops its
 * answer from reaching the client as raw constraint text.
 */
function isUsernameUniqueViolation(error: unknown): boolean {
  const err = error as { name?: string; parent?: { constraint?: string }; message?: string } | null;
  if (!err || err.name !== "SequelizeUniqueConstraintError") return false;
  return err.parent?.constraint === "usuarios_user_uniq" || /usuarios_user_uniq/i.test(err.message ?? "");
}

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

  // The same separation of powers `updateUsuario` has always applied, and this
  // door had none: handing out authority belongs to the Roles module, not to
  // whoever may open an account.
  const mayAssignRoles = await can(req.user?.id_rol, "roles", "editar");

  try {
    /**
     * Every new account is born with a role, and choosing it is the Roles
     * permission. So without that permission there is nothing this handler can
     * legitimately do, and it says so rather than failing later:
     *
     * - Asking for a role without the permission is an escalation attempt, and
     *   is refused with the same `critical` line in the bitácora that
     *   `updateUsuario` writes for the same reach. Same action name on purpose:
     *   "somebody reached for authority they may not hand out" is one thing to
     *   look for, not two.
     * - Not asking for one is not an attack, so no `critical` line — but it
     *   still cannot succeed. `id_rol` is `NOT NULL`, so before this the same
     *   request died on the database and came back as a 500 with Postgres's own
     *   text in it. A 403 naming the missing permission is the honest answer.
     *
     * The rejected alternative was to fall back to some default role. There is
     * no such thing in this system — no constant, no column default — so it
     * would have meant inventing a policy nobody decided, and quietly giving an
     * account a different role from the one the operator picked. Refusing is
     * louder and cannot surprise anyone.
     *
     * Nothing legitimate loses out today: role 1 holds `roles.editar`, and
     * roles 2 and 3 hold nothing at all in `seguridad`, so no role that can
     * reach this handler is affected.
     */
    if (!mayAssignRoles) {
      const enviado = (req.body ?? {}) as Record<string, unknown>;
      if (enviado.id_rol !== undefined) {
        logAction({ id_usuario: req.user?.id, action: "ROLE_CHANGE_DENIED", entity: "Usuario", entity_id: null, detail: "Intentó crear una cuenta con un rol elegido, sin permiso sobre Roles", metadata: { requested: enviado.id_rol, user: enviado.user }, severity: 'critical', ip_address: req.ip ?? null });
      }
      return res.status(403).json({
        message: "Crear una cuenta implica asignarle un rol. Hace falta permiso de edición sobre Roles.",
      });
    }

    // Trimmed on the way in, not only on the way out. An account stored as
    // " Diego " can never be logged into: the person types "Diego" and the
    // lookup does not match, and nothing on screen explains why.
    if (typeof req.body?.user === "string") req.body.user = req.body.user.trim();

    if (!requireUsernameString(req.body?.user)) {
      return res.status(400).json({ message: USERNAME_NOT_STRING_MESSAGE });
    }

    // Used to duplicate in silence — the vulnerability `usuarios_user_uniq`
    // closes. Now it has to ask first, or the database answers with a 500
    // full of its own constraint name.
    if (await nombreEnUso(req.body.user)) {
      return res.status(409).json({ message: USERNAME_TAKEN_MESSAGE });
    }

    const motivo = validarPassword(req.body.pass ?? "");
    if (motivo) return res.status(400).json({ message: motivo });

    req.body.pass = await bcryptjs.hash(req.body.pass, BCRYPT_COST);

    const payload = creatableFrom(req.body);
    const TempUsuario = await UsuarioModel.create(payload);
    logAction({ id_usuario: req.user?.id, action: "CREATE_USUARIO", entity: "Usuario", entity_id: TempUsuario.dataValues.id as number, detail: `Creó usuario @${req.body.user}`, metadata: { after: { user: req.body.user } }, severity: 'info' });
    res.status(200).json(withoutPass(TempUsuario));
  } catch (error) {
    if (isUsernameUniqueViolation(error)) {
      return res.status(409).json({ message: USERNAME_TAKEN_MESSAGE });
    }
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

/**
 * The fields a creation request may set: the profile, the two credentials, and
 * the role — which `createUsuario` only reaches here after checking the Roles
 * permission.
 *
 * This used to be a blacklist of two names, `failed_attempts` and
 * `locked_until`, and everything else went through. What that let past:
 *
 * - `id_rol`. The route asks only for `seguridad.crear`, and the permission
 *   matrix treats Seguridad and Roles as separate modules that the Seguridad
 *   screen lets an administrator tick separately. So a role holding
 *   `seguridad.crear` and nothing else could POST
 *   `{"user":"tmp","pass":"…","id_rol":1}`, log in as that account a second
 *   later, and be a full administrator. `updateUsuario` refuses exactly that
 *   reach and writes a `critical` line about it; the door beside it checked
 *   nothing. That is the escalation this list closes.
 * - `id`, choosing your own primary key on an autoincrement column.
 * - `deletedAt`, an account born archived.
 *
 * And the reason it is a list of what is allowed rather than a list of what is
 * not: every column added to this model from now on is otherwise accepted by
 * default, and nobody adding one would think to come here. The two lockout
 * fields it used to name are still refused — they are simply not on the list,
 * which is also what stops whoever may create accounts from planting a
 * `locked_until` far in the future on the account they create.
 */
const CREATABLE_FIELDS = [...EDITABLE_FIELDS, "user", "pass"] as const;

/** Only the named fields, and only the ones the body actually sent. */
function pick(body: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (body ?? {}) as Record<string, unknown>;
  const chosen: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) chosen[field] = source[field];
  }
  return chosen;
}

function editableFrom(body: unknown, mayAssignRoles: boolean): Record<string, unknown> {
  return pick(body, mayAssignRoles ? [...EDITABLE_FIELDS, ...ROLE_ASSIGNMENT_FIELDS] : EDITABLE_FIELDS);
}

/**
 * No `mayAssignRoles` argument, unlike `editableFrom`: `createUsuario` has
 * already refused the request outright without that permission, so by the time
 * this runs the role is always allowed.
 */
function creatableFrom(body: unknown): Record<string, unknown> {
  return pick(body, [...CREATABLE_FIELDS, ...ROLE_ASSIGNMENT_FIELDS]);
}

/**
 * The record as it may leave the server: everything except the hash.
 *
 * `failed_attempts` and `locked_until` stay visible on purpose: whoever
 * manages accounts needs to see that one is locked and why, the same way
 * `deletedAt` already travels with every user record. Only the password
 * hash is secret.
 */
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
    if (!requireUsernameString(user)) {
      return res.status(400).json({ message: USERNAME_NOT_STRING_MESSAGE });
    }

    // Case-insensitive, matching `usuarios_user_uniq`. The exact-match check
    // this replaced let a rename to `Isaias` pass the application layer while
    // `isaias` already existed, and it died on the database instead.
    if (await nombreEnUso(user, Number(id))) {
      return res.status(409).json({ message: USERNAME_TAKEN_MESSAGE });
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
    if (isUsernameUniqueViolation(error)) {
      return res.status(409).json({ message: USERNAME_TAKEN_MESSAGE });
    }
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

    const motivo = validarPassword(pass ?? "");
    if (motivo) return res.status(400).json({ message: motivo });

    const hashedPass = await bcryptjs.hash(pass, BCRYPT_COST);
    /**
     * A new password lifts the lockout, in the same write.
     *
     * The lockout had no way out at all. `failed_attempts` is only ever cleared
     * by a successful login, and a successful login is impossible while the
     * account is locked, because the login answers before it compares anything.
     * So the count only ever grew: five wrong guesses, wait out the minute, send
     * one more, and from the fourth round on the wait pins itself at
     * LOCKOUT_MAX_MINUTES. From there one request every quarter of an hour keeps
     * the account shut indefinitely, from a single address, without coming near
     * any rate-limit bucket. The only remedy was an UPDATE by hand in Postgres.
     *
     * And the everyday half of the same problem: an administrator resets a
     * password precisely because somebody cannot get in. Leaving the lock on
     * meant dictating the new password and having the login still answer
     * "Usuario o contraseña incorrectos" for up to fifteen minutes, with neither
     * of them able to tell that apart from having heard it wrong.
     */
    TempUsuario.set({ pass: hashedPass, failed_attempts: 0, locked_until: null });

    const isSelf = loggedUser.id === Number(id);
    /**
     * A new password ends the old sessions, which until now it did not.
     *
     * Changing a password — the thing you do *because* somebody else may know
     * the old one — left every browser that knew it logged in, for up to thirty
     * days. An administrator resetting the password of a leaver was doing
     * nothing whatsoever to the laptop in their bag. The design plans a
     * `pass_changed_at` column and a `sesion.created_at >= u.pass_changed_at`
     * check on top of this, as belt and braces; **that column does not exist
     * yet** — the Plan 1 migration created only `failed_attempts` and
     * `locked_until` — and it is not added here on purpose: a column nobody
     * writes is worse than no column, so it arrives together with its write and
     * the query that reads it, or not at all.
     *
     * One exception, and only one: your own current session survives. Without
     * it, changing your own password answers 200 and then refuses your very
     * next request, which reads as the change having failed and invites doing it
     * again. `except` is only passed when the account being changed is the
     * caller's own — an administrator resetting somebody else must not spare
     * anything, and their own session id would not be among that person's rows
     * anyway.
     *
     * `id_sesion` is `undefined` on a request that arrived with the old bearer
     * token, and `revokeAllSessionsOf` reads that as "spare nothing": there is
     * no row to spare, the JWT keeps working until it expires, and every real
     * session of that account is closed. Answering that case by sparing an
     * unknown id would revoke nothing at all.
     *
     * Both writes in one transaction, for the same reason `deleteUsuario` uses
     * one, and the failure it prevents is nastier than it looks. Saved outside a
     * transaction, a revocation that fails leaves the password **already
     * changed** and answers 500 — and the retry does not repair it, it makes it
     * worse: the form sends the same `oldPass`, which no longer matches the
     * stored hash, so the second attempt answers 401 "La contraseña actual
     * suministrada no es correcta". Ana changes her password because she thinks
     * somebody knows it, the UPDATE on `sesiones` loses a lock race against the
     * `touchSession` writes of a running export, and she is told her current
     * password is wrong — while it has in fact changed and her old sessions are
     * still alive for a week. It does not take the database being down; it
     * takes one lock conflict on a table every request writes to.
     */
    const revocadas = await sequelize.transaction(async (transaction) => {
      await TempUsuario.save({ transaction });
      return revokeAllSessionsOf(Number(id), {
        except: isSelf ? loggedUser.id_sesion : undefined,
        transaction,
      });
    });

    logAction({ id_usuario: req.user?.id, action: "CHANGE_PASSWORD", entity: "Usuario", entity_id: Number(id), detail: isSelf ? "Cambió su contraseña" : `Cambió contraseña del usuario #${id}`, metadata: { target_user_id: Number(id), self: isSelf, sesiones_revocadas: revocadas }, severity: 'critical', ip_address: req.ip ?? null });
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
    /**
     * Archiving an account and ending its sessions, or neither.
     *
     * The `ON DELETE RESTRICT` on `sesiones.id_usuario` does nothing here and
     * never will: this is a soft delete, the row stays where it is with a
     * `deletedAt` on it, and no foreign key fires on an UPDATE. So archiving
     * somebody used to leave every browser they were logged in on working
     * until the session hit its own expiry — up to thirty days for the person
     * whose access you just took away. `authenticate` refuses an archived
     * account on the next request, which covers it from the moment this
     * commits; revoking the rows is what makes the sessions screen honest and
     * what closes the gap if that check is ever moved or cached.
     *
     * One transaction, because half of this is worse than none. Archived with
     * live sessions is the hole itself; sessions killed without the archive is
     * an account that looks fine to an administrator and cannot be used. If the
     * revocation fails the archive rolls back, the caller gets a 500, and
     * retrying does the whole thing.
     */
    const revocadas = await sequelize.transaction(async (transaction) => {
      await UsuarioModel.destroy({ where: { id }, transaction });
      return revokeAllSessionsOf(Number(id), { transaction });
    });
    logAction({ id_usuario: req.user?.id, action: "DELETE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Archivó usuario #${id}`, metadata: { sesiones_revocadas: revocadas }, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
/**
 * Lets a locked account back in.
 *
 * The valve. Until now a lockout could only be cleared by a successful login,
 * and a locked account cannot log in successfully — see the comment in
 * `updateUserPass`, which clears it as a side effect of a reset. That covered
 * the case where the password also needs changing; this covers the case where it
 * does not, and it is the one an administrator with a phone in their hand can
 * actually reach.
 *
 * `seguridad.editar`, the same permission a password reset needs: undoing a
 * lockout for somebody else is the same kind of act on the same kind of record.
 * Not `requireSelfOrPermission` — a locked-out person has no session to call it
 * with, and "unlock yourself" would not be a lockout.
 *
 * The design this came from (`docs/specs/2026-08-21-autenticacion-mfa-design.md`,
 * §6) mitigates the same problem differently: the lockout would not apply to a
 * login arriving with a valid remembered-device cookie. That cannot be built
 * yet — remembered devices belong to a later plan and the table does not exist —
 * so this endpoint is the provisional way out, and §8 of the same document
 * already plans a rescue script beside it.
 */
export async function desbloquearUsuario(req: Request, res: Response) {
  const { id } = req.params;
  if (!(await can(req.user?.id_rol, "seguridad", "editar"))) {
    return res.status(403).json({ message: "No tienes permiso para desbloquear usuarios." });
  }
  try {
    const TempUsuario = await UsuarioModel.findOne({ where: { id } });
    if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });

    const antes = {
      failed_attempts: TempUsuario.dataValues.failed_attempts ?? 0,
      locked_until: TempUsuario.dataValues.locked_until ?? null,
    };
    TempUsuario.set({ failed_attempts: 0, locked_until: null });
    await TempUsuario.save();
    // `critical`, like changing somebody else's password: this removes a
    // protection from an account, and it is exactly the line to read when
    // asking how an attacker got past a lockout. Recorded with what the
    // lockout was, so the entry says what was undone and not merely that
    // something was.
    logAction({ id_usuario: req.user?.id, action: "ACCOUNT_UNLOCKED", entity: "Usuario", entity_id: Number(id), detail: `Desbloqueó la cuenta del usuario #${id}`, metadata: { before: antes }, severity: 'critical', ip_address: req.ip ?? null });
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
    // paranoid: false — the row being restored is, by definition, currently
    // soft-deleted, so the default paranoid findOne would never see it.
    const archivado = await UsuarioModel.findOne({ where: { id }, paranoid: false });
    if (!archivado) return res.status(404).json({ message: "Usuario no encontrado" });

    const nombre = archivado.dataValues.user as string;

    // The scenario this closes: the account was archived, its name handed to
    // a new, living account, and only now — bringing the old one back — does
    // anyone find out. `restore()` alone would hit `usuarios_user_uniq` and
    // hand the client Postgres's raw constraint text, forever, since nothing
    // about retrying the same restore would ever change the outcome.
    if (await nombreEnUso(nombre, Number(id))) {
      return res.status(409).json({
        message: `El nombre de usuario "${nombre}" ya lo tiene otra cuenta activa. Cambia el nombre de una de las dos antes de desarchivar esta.`,
      });
    }

    await UsuarioModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Desarchivó usuario #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    if (isUsernameUniqueViolation(error)) {
      return res.status(409).json({ message: USERNAME_TAKEN_MESSAGE });
    }
    return res.status(500).json({ message: error.message });
  }
}
