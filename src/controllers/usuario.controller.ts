import { Request, Response } from "express";
import { Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import { revokeAllRememberedDevicesOf } from "../auth/rememberedDeviceStore.js";
import { issueSession } from "../auth/issueSession.js";
import { verifyOwnPassword } from "../auth/credentials.js";
import bcryptjs from "bcryptjs";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { can } from "../permissions/store.js";
import { BCRYPT_COST } from "../config/security.js";
import { validarPassword } from "../utils/password.js";
import { whereUsernameIs } from "../utils/username.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const usuarioLog = log("usuario");
const handler = makeHandler(usuarioLog);

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
 * Shared text: the caller did not send their current password.
 *
 * Two handlers on this file answer it now, and they have to answer it with the
 * same sentence — a rename and a password change are the same demand made of
 * the same person, and wording them differently is how one of them ends up
 * sounding optional. Exported so the tests can pin the *reason* rather than the
 * number: this route already answers 400 to a username that is not a string,
 * so a test asserting `toBe(400)` alone would pass through the wrong branch.
 * That exact accident happened earlier in this plan with a 401.
 */
export const CURRENT_PASSWORD_REQUIRED_MESSAGE = "Debe proporcionar su contraseña actual.";

/** Shared text: they sent one and it is not theirs. Same sentence on both routes. */
export const CURRENT_PASSWORD_WRONG_MESSAGE = "La contraseña actual suministrada no es correcta.";

/**
 * Whether this credential change has to prove the caller's password first.
 *
 * One rule for both of them — the rename below and the password change after it
 * — because it is one decision and it was worth writing down once:
 *
 * > The exemption `seguridad.editar` grants is for **rescuing somebody else**.
 * > It never applies to acting on your own account.
 *
 * So this is true exactly when the account being changed is the caller's own,
 * and **holding the permission does not lift it.**
 *
 * **Why the exemption exists at all**, because it is legitimate and must keep
 * working: an administrator resets a password precisely because somebody cannot
 * get in. Demanding the current one there is demanding what nobody has — not
 * the locked-out person, and certainly not the administrator helping them. Same
 * for a rename of somebody else's account: the target's password is unknown to
 * the caller by design.
 *
 * **Why it stops at your own account.** Renaming or re-passwording *yourself*
 * rescues nobody. There is no locked-out person on the other side of it, no
 * operational need it serves, and you hold your own current password because
 * you logged in with it minutes ago — so the exemption buys nothing and gives
 * up the only thing this check is here for.
 *
 * And it gives it up in the worst place. What this closes is an unattended
 * machine with a live session: whoever sits down changes the credential and
 * locks its owner out without ever learning the password. An administrator's
 * unattended machine is the same act with more reach, so exempting
 * administrators leaves the hole open exactly on the accounts where it costs
 * most — which is how the condition came to be written against the *permission*
 * instead of against *whose account it is*, and it read as prudence.
 *
 * A password change is the sharper of the two. A rename locks its owner out of
 * a name an administrator can hand back; a password change ends every other
 * session of that account in the same request, so the attacker stays in on the
 * session already open and the owner cannot come back at all. **On a password
 * change, the exemption made the administrator the attacker.**
 *
 * Exported because `usuario.routes.ts` needs the same answer to decide whether
 * a request pays into the password-confirmation budget. One function, so the
 * rate limit and the two handlers can never disagree about which requests
 * compare a password.
 *
 * `Number(req.params.id)` and not the raw string, matching the "is this me"
 * comparison the IDOR guard in each handler already makes. Two notions of
 * "self" on one route is the drift worth ruling out here: the guard deciding
 * ownership one way and the gate deciding it another is how a request slips
 * through as somebody else's while being charged as your own.
 */
export function requiresOwnPassword(req: Request): boolean {
  const target = Number(req.params?.id);
  return typeof req.user?.id === "number" && req.user.id === target;
}

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

export const getUsuario = handler("getUsuario", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";

  const TempUsuario = await UsuarioModel.findAll({
    order: [["id", "DESC"]],
    attributes: { exclude: ["pass"] },
    include: [{ model: RolModel }],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
  });
  res.status(200).json(TempUsuario);
});
export const searchUsuario = handler("searchUsuario", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempUsuario = await UsuarioModel.findOne({
    where: { id },
    attributes: { exclude: ["pass"] },
    include: [{ model: RolModel }],
  });
  res.status(200).json(TempUsuario);
});

export const searchUsuario_user = handler("searchUsuario_user", async (req: Request, res: Response) => {
  const { user } = req.params;

  const TempUsuario = await UsuarioModel.findOne({
    where: { user },
    attributes: { exclude: ["pass"] },
  });
  if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });
  res.status(200).json(TempUsuario);
});

export const createUsuario = handler("createUsuario", async (req: Request, res: Response) => {
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
    // Anything that is not the name clash goes up to `handler`, which files it
    // under this controller's log with the route attached and answers a neutral
    // 500. It used to be sent to the browser verbatim.
    throw error;
  }
});
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

export const updateUsuario = handler("updateUsuario", async (req: Request, res: Response) => {
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
});
export const updateUserName = handler("updateUserName", async (req: Request, res: Response) => {
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

    /**
     * Renaming yourself proves it is you, and it proves it before anything else
     * happens.
     *
     * **Why a username is worth this at all.** It is half of the credential.
     * Change somebody's username and they cannot log in — not because they have
     * forgotten their password, but because they no longer know what name to
     * offer it with. So this operation is worth what a password change is
     * worth, and `updateUserPass` below had demanded the current password of
     * ordinary callers all along while this one demanded nothing whatsoever.
     * (Of *ordinary* callers, and that qualifier turned out to matter: it
     * exempted anybody who could manage accounts, their own password included.
     * Same asymmetry, same fix, and it is one function now — see
     * `requiresOwnPassword`.)
     *
     * The concrete case: an unattended machine in the office, or the shared
     * field laptop. Whoever sits down at a live session renames the account and
     * **locks its owner out of it without knowing the password**. It is
     * repairable — an administrator hands the name back — but nobody
     * understands what happened in the meantime.
     *
     * **Why here and not on the screen.** Both screens that rename an account
     * asked for a password; one of them then sent the change without it, and
     * the other never asked. A confirmation that lives only in the client is
     * optional by definition: whoever does not want to type it uses the other
     * screen, or `curl`. Which of the two is a real gate is settled entirely by
     * where the check runs, and that is here.
     *
     * **Who has to pass it** is `requiresOwnPassword` — the answer is not
     * "whoever lacks a permission", and the reasoning is up there with it.
     *
     * **Before the collision check**, deliberately: a caller who has not proved
     * who they are learns nothing from this endpoint about which usernames are
     * taken. It costs an early return on a request that was going to be a 409
     * anyway.
     *
     * **`verifyOwnPassword` and not a `bcryptjs.compare` of its own.** It asks
     * exactly the question this needs answered — is this the password of the
     * account already asking? — and it carries what a fresh comparison here
     * would have quietly lacked: the `checkAgainstRow` the login shares, the
     * filler hash that levels the timings, and a `PASSWORD_CONFIRM_FAILED` line
     * that records the failed attempt without forging a login nobody made. This
     * is that function's only caller now, since the confirmation endpoint it was
     * written alongside is retired.
     *
     * **It does not apply the lockout, and that took a defect to get right.**
     * This paragraph used to list "the refusal to let a locked account through a
     * side door that would clear its own lockout" among the things borrowed here,
     * as though it were a benefit. It was the opposite. `authenticate` does not
     * read `locked_until`, so somebody whose account was locked by another
     * machine grinding their username keeps the session they already had and
     * keeps working — and this screen told them their **correct** password was
     * wrong, charged the shared budget for the lie, and at the fifth attempt
     * answered 429 on the same bucket as the password change, which was their way
     * out. `LockoutPolicy` in `auth/credentials.ts` is where that decision lives
     * now, by name.
     *
     * It also, on purpose, does **not** touch `failed_attempts`: mistyping your
     * own password while renaming yourself must not be able to shut you out of
     * the ERP. That is why the budget against guessing lives on the route
     * instead — see `usuario.routes.ts`, and note that the budget only charges
     * for the 401 below, so a rename that fails for any other reason is free.
     *
     * The id comes from `req.user` and never from `:id`. They are equal here by
     * the check just made, and reading it off the session is what keeps that
     * true if this block is ever moved.
     */
    if (requiresOwnPassword(req)) {
      const oldPass = (req.body as { oldPass?: unknown } | undefined)?.oldPass;
      // Not a string is not a password, and an empty one is not a
      // confirmation — refused before the round trip, the same way
      // `verifyOwnPassword` refuses them, so the two cannot disagree about
      // what counts as "sent nothing".
      if (typeof oldPass !== "string" || oldPass === "") {
        return res.status(400).json({ message: CURRENT_PASSWORD_REQUIRED_MESSAGE });
      }
      const confirmacion = await verifyOwnPassword({
        id: loggedUser.id,
        pass: oldPass,
        ip: req.ip ?? null,
      });
      if (!confirmacion.ok) {
        // Archived between `authenticate` and here — the narrow race
        // `verifyOwnPassword` names. Answered as the 404 the lookup below
        // would have given anyway, and pointedly not as a wrong password:
        // sending somebody hunting for a typo in a password that was right is
        // worse than telling them nothing.
        if (confirmacion.reason === "no-account") {
          return res.status(404).json({ message: "Usuario no encontrado" });
        }
        return res.status(401).json({ message: CURRENT_PASSWORD_WRONG_MESSAGE });
      }
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
    // Anything that is not the name clash goes up to `handler`, which files it
    // under this controller's log with the route attached and answers a neutral
    // 500. It used to be sent to the browser verbatim.
    throw error;
  }
});

export const updateUserPass = handler("updateUserPass", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { pass, oldPass } = req.body;
  const loggedUser = req.user;

  // Validación de Permisos (IDOR protection)
  const mayResetPasswords = await can(loggedUser?.id_rol, "seguridad", "editar");
  if (!loggedUser || (loggedUser.id !== Number(id) && !mayResetPasswords)) {
    return res.status(403).json({ message: "No tienes permiso para editar la contraseña de este usuario." });
  }

  const TempUsuario = await UsuarioModel.findOne({
    where: { id },
  });
  if (!TempUsuario) return res.status(404).json({ message: "Usuario no encontrado" });

  /**
   * Changing your own password proves it is you. The exemption is for
   * changing somebody else's.
   *
   * **What this replaced, and it was the worst hole of this plan.** The
   * condition read `if (oldPass) { compare } else if (!mayResetPasswords)
   * { refuse }` — it looked at the *permission* and never at *whose account
   * it is*. So anybody holding `seguridad.editar` could change **their own**
   * password without knowing the current one. The unattended machine with an
   * administrator's session open: whoever sits down sets a new password,
   * their own session survives (`isSelf` spares it below) and every other
   * session of that account ends in the same write — so the owner is locked
   * out of their own account behind a password only the attacker knows. The
   * revocation is right and stays; it is what makes this the whole account
   * rather than an inconvenience.
   *
   * **Who has to pass it** is `requiresOwnPassword`, the same function the
   * rename above branches on and the rate limit in `usuario.routes.ts` reads.
   * The reasoning lives with it. Short version: an administrator resetting
   * *somebody else's* password still sends nothing, because that is what the
   * permission authorises and there is no password they could know.
   *
   * **`bcryptjs.compare` here, and not the shared `verifyOwnPassword` the
   * rename uses.** Two ways of comparing a password in one file needs a
   * reason, and the reason has changed — which is worth saying, because the
   * one written here first was the load-bearing one and it is gone.
   *
   * It was the lockout. The shared door refused a resting account before it
   * compared anything, and that is exactly wrong for this handler, where
   * lifting the lockout is the *point* — see the write below. So this compared
   * its own hash to stay out of the way of it. That refusal turned out to be
   * wrong for the **rename** too, for the same reason and with worse
   * consequences, and it is now a named policy rather than a fact about the
   * shared door: see `LockoutPolicy` in `auth/credentials.ts`. Both doors leave
   * the lockout to the login, so this handler could go through the shared one
   * today without breaking the rescue.
   *
   * What keeps them separate now is only the wasted work, and it is enough to
   * leave alone rather than enough to have chosen. The shared door reads the
   * row again by id — this handler is holding it already, forty lines above.
   * Its filler hash levels the timing of a lookup *by username*, to stop
   * enumeration; there is no name in this request to probe with, and "no such
   * account" was answered as a 404 above. And its success path re-hashes at
   * the current cost and clears the two lockout columns — both of which the
   * write below is about to do anyway, inside a transaction, so borrowing them
   * would buy a second bcrypt (~250 ms on every password change) and two
   * UPDATEs whose results are immediately overwritten.
   *
   * What is worth borrowing is the bitácora line, and it is taken: the same
   * action name `verifyOwnPassword` writes, so a run of failed confirmations
   * on one account reads as one event whichever door it arrived at. Without
   * it the 429 from the budget below would have nothing behind it explaining
   * why.
   *
   * A wrong password here does **not** move `failed_attempts`, matching the
   * rename and for the same reason: mistyping your current password while
   * changing it must not be able to shut you out of the ERP. What stops that
   * from being an unlimited oracle is `passwordConfirmLimiter` on the route —
   * which this endpoint had never had, while it was already comparing
   * passwords with nothing counting them at all.
   *
   * An `oldPass` that arrives on a change to **somebody else's** account is
   * ignored rather than compared, which is new. Compared, it was checked
   * against the *target's* hash — an unlimited 401-or-not oracle against
   * another person's password, for a caller who can reset it outright anyway
   * and would learn the plaintext by guessing. Nothing is given up: the
   * permission is what authorises that request, with or without a password on
   * it.
   */
  if (requiresOwnPassword(req)) {
    // Not a string is not a password and an empty one is not a confirmation,
    // refused the same way the rename refuses them so the two cannot disagree
    // about what counts as "sent nothing". The old `if (oldPass)` treated
    // every falsy value as "did not send one" and fell through to the
    // permission, which is the shape the hole above had.
    if (typeof oldPass !== "string" || oldPass === "") {
      return res.status(400).json({ message: CURRENT_PASSWORD_REQUIRED_MESSAGE });
    }
    const isMatch = await bcryptjs.compare(oldPass, TempUsuario.dataValues.pass);
    if (!isMatch) {
      logAction({ id_usuario: loggedUser.id, action: "PASSWORD_CONFIRM_FAILED", entity: "Usuario", entity_id: loggedUser.id, detail: `Contraseña incorrecta al cambiar la contraseña de @${TempUsuario.dataValues.user}`, metadata: { user: TempUsuario.dataValues.user }, severity: 'warning', ip_address: req.ip ?? null });
      return res.status(401).json({ message: CURRENT_PASSWORD_WRONG_MESSAGE });
    }
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
  TempUsuario.set({
    pass: hashedPass,
    failed_attempts: 0,
    locked_until: null,
    // The stamp `authenticate` measures every session against, in the same
    // `set` as the hash so there is no ordering in which the password is the
    // new one and the stamp still names the old.
    pass_changed_at: new Date(),
  });

  const isSelf = loggedUser.id === Number(id);
  /**
   * A new password ends the old sessions, which until now it did not.
   *
   * Changing a password — the thing you do *because* somebody else may know
   * the old one — left every browser that knew it logged in, for up to thirty
   * days. An administrator resetting the password of a leaver was doing
   * nothing whatsoever to the laptop in their bag. The belt over these
   * braces is `usuarios.pass_changed_at`, stamped in the `set` above:
   * `authenticate` refuses any session opened before it, so an endpoint that
   * changes a password and forgets to revoke still cannot leave a live
   * session behind it.
   *
   * **Nothing is spared here, and that is a change.** This used to pass
   * `except: isSelf ? loggedUser.id_sesion : undefined`, keeping the caller's
   * own session alive — because otherwise changing your own password answers
   * 200 and then refuses your very next request, which reads as the change
   * having failed and invites doing it again. That reasoning was right and
   * the problem it names is real; what replaced it is the rotation below.
   *
   * Sparing a row and stamping the column cannot both be true. The spared
   * session was opened on Tuesday, the stamp says Thursday, and
   * `authenticate` reads Tuesday < Thursday and answers 401 — so the
   * exception would have gone on being written here while being dead in
   * fact, and no test of it would have noticed, because the thing killing it
   * lives in another file.
   *
   * Of the ways to reconcile the two, rotating is the only one that does not
   * buy the exception back in some other currency. Moving the spared
   * session's `created_at` forward would corrupt the anchor of the thirty-day
   * ceiling — change your password every twenty-nine days and the session
   * never dies, which is a worse hole than the one being closed. A column
   * recording that one session had acknowledged the change would be a column
   * whose only job is to punch a hole in the rule this whole mechanism is.
   * Simply logging the caller out is the UX failure the paragraph above
   * describes. **The rule in `authenticate` is worth having precisely because
   * it has no exceptions**, and rotation is what keeps that true.
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
  const { sesiones: revocadas, dispositivos } = await sequelize.transaction(async (transaction) => {
    await TempUsuario.save({ transaction });
    const sesiones = await revokeAllSessionsOf(Number(id), { transaction });
    /**
     * A remembered device is a cookie that skips the *next* login's second
     * factor entirely — read before there is any session for `authenticate`
     * to refuse. Revoking every session while leaving that cookie standing
     * would still let whoever this password change was meant to shut out
     * straight back in, unchallenged, on the very next login. Same finding
     * as `deleteUsuario`'s own archive below, one call site later than it.
     *
     * **Inside this transaction, and that is a different answer than the
     * one a few lines down.** The rotation that follows this whole block —
     * `issueSession`, for `isSelf` — deliberately runs *after* this
     * transaction commits and swallows its own failure, because by then the
     * password is already saved and a 500 there would send the caller into
     * a retry with an `oldPass` that no longer matches. None of that
     * applies here: this transaction has not committed anything yet, so a
     * failure rolls the hash and the session revocation back with it. The
     * caller's current password is still the one they just typed, a 500 is
     * an honest description of "nothing changed", and a retry costs them
     * nothing extra. Answering 200 with a password changed and a device
     * still able to skip the factor would be the worse of the two ways to
     * get this wrong — the one that looks like success.
     */
    const dispositivos = await revokeAllRememberedDevicesOf(Number(id), { transaction });
    return { sesiones, dispositivos };
  });

  /**
   * The replacement credential, for the caller only, and never at the cost of
   * the answer.
   *
   * **Outside the transaction on purpose.** `createSession` takes no
   * transaction, and the atomicity that matters is the pair above — a
   * password changed with its old sessions still alive is the hole; a
   * password changed with no new cookie is somebody logging in again.
   *
   * **The catch is load-bearing and must not become a rethrow.** By this line
   * the password is committed. Answering 500 says "it did not work", and the
   * retry sends the same `oldPass` against a hash that has already changed —
   * so the second attempt answers "La contraseña actual suministrada no es
   * correcta" about a change that succeeded. Swallowing this costs the caller
   * their cookie and nothing else: they log in again, with the new password,
   * and it works.
   *
   * **`mfa_satisfied_at` does not come across, and that is the point rather
   * than an oversight to tidy up later.** The new row starts with no step-up
   * proof, so a factor proved a minute ago has to be proved again for the
   * next protected write. Changing a password is not evidence of possessing a
   * second factor — it is evidence of knowing the password, which is what the
   * new session has proved and all it has proved. Carrying the old proof
   * across would mean a stolen session that also knows the password could
   * refresh itself into a step-up-authorised session indefinitely, without
   * ever touching a factor.
   *
   * **A request already in flight across this rotation gets 401, by design.**
   * Anything the page fired before this response landed authenticates against
   * a row that is now revoked, and the window is real rather than theoretical:
   * it runs from the commit to the response arriving, with two bcrypt
   * operations sitting in front of it. The old `except` spared exactly that
   * case, and giving it up is the price of the rule having no exceptions —
   * paid deliberately, not overlooked. The client's part is to retry such a
   * request once rather than treat the 401 as the end of the session; the new
   * cookie is already on the response that raced it.
   *
   * `estado` **is** carried across, from the session making the request.
   * Today only `completa` can reach this route at all — `sessionState.ts`
   * opens nothing outside `/api/auth/*` to the other two — so a literal
   * `"completa"` would behave identically and would be a silent promotion the
   * day that allowlist widens.
   */
  if (isSelf) {
    try {
      await issueSession(req, res, loggedUser.id, loggedUser.estado);
    } catch (err) {
      logAction({ id_usuario: loggedUser.id, action: "SESSION_ROTATION_FAILED", entity: "Usuario", entity_id: loggedUser.id, detail: "Cambió su contraseña, pero no se pudo abrir la sesión nueva", metadata: { error: err instanceof Error ? err.message : String(err) }, severity: 'warning', ip_address: req.ip ?? null });
    }
  }

  logAction({ id_usuario: req.user?.id, action: "CHANGE_PASSWORD", entity: "Usuario", entity_id: Number(id), detail: isSelf ? "Cambió su contraseña" : `Cambió contraseña del usuario #${id}`, metadata: { target_user_id: Number(id), self: isSelf, sesiones_revocadas: revocadas, dispositivos_revocados: dispositivos }, severity: 'critical', ip_address: req.ip ?? null });
  res.status(200).json(withoutPass(TempUsuario));
});
export const deleteUsuario = handler("deleteUsuario", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await can(req.user?.id_rol, "seguridad", "archivar"))) {
    return res.status(403).json({ message: "No tienes permiso para eliminar usuarios." });
  }

  /**
   * Archiving an account, ending its sessions and cutting off its remembered
   * devices — all three, or none.
   *
   * The `ON DELETE RESTRICT` on `sesiones.id_usuario` and on
   * `dispositivo_recordado.id_usuario` does nothing here and never will: this
   * is a soft delete, the row stays where it is with a `deletedAt` on it, and
   * no foreign key fires on an UPDATE. So archiving somebody used to leave
   * every browser they were logged in on working until the session hit its
   * own expiry — up to thirty days for the person whose access you just took
   * away. `authenticate` refuses an archived account on the next request,
   * which covers the sessions from the moment this commits; revoking the rows
   * is what makes the sessions screen honest and what closes the gap if that
   * check is ever moved or cached.
   *
   * **The remembered devices are not covered by that check, and they outlive
   * the archive.** A remembered device is what lets a login *skip* the second
   * factor, so it is read before there is any session for `authenticate` to
   * refuse. While the account is archived that does not matter — `UsuarioModel`
   * is `paranoid`, so the login's own `findOne` never finds the row and nobody
   * gets that far. What matters is the undo: `desarchivarUsuario` restores the
   * row and touches nothing else, so every unexpired device cookie comes back
   * with the account, still good for skipping the factor. Revoking them here
   * is what makes an archive survive being reversed.
   *
   * And it is the deliberate asymmetry with `factor_totp`,
   * `credencial_webauthn` and `codigo_recuperacion`, which are left alone for
   * exactly that reason — so un-archiving gives somebody their account back
   * with their factors intact. A factor is something only that person has; a
   * remembered device is a machine that may since have changed hands.
   *
   * One transaction, because half of this is worse than none. Archived with
   * live sessions is the hole itself; sessions killed without the archive is
   * an account that looks fine to an administrator and cannot be used; and an
   * account archived whose devices still work looks closed on the screen and
   * is open in the field. If any of the three fails the whole thing rolls
   * back, the caller gets a 500, and retrying does all of it.
   */
  const revocadas = await sequelize.transaction(async (transaction) => {
    await UsuarioModel.destroy({ where: { id }, transaction });
    const sesiones = await revokeAllSessionsOf(Number(id), { transaction });
    const dispositivos = await revokeAllRememberedDevicesOf(Number(id), { transaction });
    return { sesiones, dispositivos };
  });
  logAction({ id_usuario: req.user?.id, action: "DELETE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Archivó usuario #${id}`, metadata: { sesiones_revocadas: revocadas.sesiones, dispositivos_revocados: revocadas.dispositivos }, severity: 'critical' });
  return res.sendStatus(200);
});
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
 * Not `requireSelfOrPermission` — a locked-out person usually has no session to
 * call it with (`authenticate` does not read `locked_until`, so one opened
 * before the lockout does survive), and "unlock yourself" would not be a
 * lockout.
 *
 * The design this came from (`docs/specs/2026-08-21-autenticacion-mfa-design.md`,
 * §6) mitigates the same problem differently: the lockout would not apply to a
 * login arriving with a valid remembered-device cookie. That cannot be built
 * yet — remembered devices belong to a later plan and the table does not exist —
 * so this endpoint is the provisional way out, and §8 of the same document
 * already plans a rescue script beside it.
 */
export const desbloquearUsuario = handler("desbloquearUsuario", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await can(req.user?.id_rol, "seguridad", "editar"))) {
    return res.status(403).json({ message: "No tienes permiso para desbloquear usuarios." });
  }

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
});
export const desarchivarUsuario = handler("desarchivarUsuario", async (req: Request, res: Response) => {
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
    // Anything that is not the name clash goes up to `handler`, which files it
    // under this controller's log with the route attached and answers a neutral
    // 500. It used to be sent to the browser verbatim.
    throw error;
  }
});
