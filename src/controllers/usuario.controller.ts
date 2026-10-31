import { Request, Response } from "express";
import { Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { TramoModel } from "../models/tramo.model.js";
import { INCLUDE_TRAMO, presentarTramo, type TramoPresentado } from "../tramos/presentacion.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import { revokeAllRememberedDevicesOf } from "../auth/rememberedDeviceStore.js";
import { issueSession } from "../auth/issueSession.js";
import { estadoInicialDeSesion } from "../auth/factorInventory.js";
import { restablecerSegundoFactor, type ActorRescate } from "../auth/rescueCore.js";
import bcryptjs from "bcryptjs";
import { deleteImageIfUnreferenced } from "../utils/imageRefs.js";
import { logAction } from "../utils/logAction.js";
import { can } from "../permissions/store.js";
import { BCRYPT_COST } from "../config/security.js";
import { validarPassword } from "../utils/password.js";
import { whereUsernameIs } from "../utils/username.js";
import {
  construirFichero, esFormato, responderFichero, responderFalloDeExport,
  subtituloDeFiltros, type Columna,
} from "../exports/tabla.js";
import { exportSlot } from "../reportBuilder/export/queue.js";
import { MAX_EXPORT_ROWS } from "../reportBuilder/export/index.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

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
 * The caller did not send their current password.
 *
 * `updateUserPass` is the one handler that answers this. It used to be two —
 * the rename asked as well, until the reauthentication window moved that
 * demand onto the gate, where it belongs and where it can also ask for a
 * factor. What is left here is not a proof of identity at all: on a password
 * change the current password is *half of what is being changed*, and typing
 * it is the operation rather than a toll on the way to it (Isaias,
 * 2026-09-08).
 *
 * Exported so tests can pin the *reason* rather than the number, which matters
 * on a route that has more than one way to answer 400. That exact accident
 * happened earlier in this plan with a 401.
 */
export const CURRENT_PASSWORD_REQUIRED_MESSAGE = "Debe proporcionar su contraseña actual.";

/** They sent one and it is not theirs. */
export const CURRENT_PASSWORD_WRONG_MESSAGE = "La contraseña actual suministrada no es correcta.";

/**
 * Whether this request is somebody changing their **own** password.
 *
 * Read by `updateUserPass` below, to decide whether to compare `oldPass` at
 * all, and by `usuario.routes.ts`, to decide whether the request pays into the
 * password-confirmation budget. One function, so the rate limit and the
 * handler can never disagree about which requests compare a password.
 *
 * The rule it encodes, worth writing down once:
 *
 * > The exemption `seguridad.editar` grants is for **rescuing somebody else**.
 * > It never applies to acting on your own account.
 *
 * So this is true exactly when the account being changed is the caller's own,
 * and **holding the permission does not lift it.**
 *
 * 🔴 It used to answer for the rename too. It does not any more: renaming
 * proves identity at the gate on the route (`requireStepUp()`), for everybody,
 * whoever the target is — so there is no longer a question here for a rename
 * to ask.
 *
 * **Why the exemption exists at all**, because it is legitimate and must keep
 * working: an administrator resets a password precisely because somebody cannot
 * get in. Demanding the current one there is demanding what nobody has — not
 * the locked-out person, and certainly not the administrator helping them.
 *
 * **Why it stops at your own account.** Re-passwording *yourself* rescues
 * nobody. There is no locked-out person on the other side of it, no operational
 * need it serves, and you hold your own current password because you logged in
 * with it minutes ago — so the exemption buys nothing and gives up the only
 * thing this check is here for.
 *
 * And it gives it up in the worst place. A password change ends every other
 * session of that account in the same request, so on an unattended machine with
 * a live session the attacker stays in on the session already open and the
 * owner cannot come back at all. An administrator's unattended machine is the
 * same act with more reach, so exempting administrators left the hole open
 * exactly on the accounts where it costs most — which is how the condition came
 * to be written against the *permission* instead of against *whose account it
 * is*, and it read as prudence. **The exemption made the administrator the
 * attacker.**
 *
 * `Number(req.params.id)` and not the raw string, matching the "is this me"
 * comparison the IDOR guard in the handler already makes. Two notions of
 * "self" on one route is the drift worth ruling out here: the guard deciding
 * ownership one way and this deciding it another is how a request slips
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
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const listado = await listar(UsuarioModel, {
    order: [["id", "DESC"]],
    attributes: { exclude: ["pass"] },
    include: [{ model: RolModel }],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});
// ── Export ────────────────────────────────────────────────────────────

/**
 * The columns of the staff directory file.
 *
 * **This list is the security control of this endpoint**, and the reason it is
 * written out instead of borrowed from `getUsuario` above. That handler
 * projects `attributes: { exclude: ["pass"] }` — a blacklist of exactly one
 * field — so every row it sends also carries `email`, `email_verified_at`,
 * `mfa_grace_until`, `locked_until` and `failed_attempts`. On the screen those
 * feed the lock and verification badges. In a spreadsheet that gets forwarded
 * they are something else entirely: the recovery address of every account, and
 * a column saying **which accounts can currently sign in without a second
 * factor and until when**. Reusing the listing's projection here would have
 * turned a directory export into a target list.
 *
 * `Nacimiento` is on the list because it was on the browser's list, not
 * because the screen shows it — no column of the users table does. It is
 * flagged rather than silently dropped: taking data out of a file people
 * already use is a decision, not a cleanup.
 */
const COLUMNAS_USUARIO: readonly Columna[] = [
  { key: "n", label: "#", kind: "number" },
  { key: "name", label: "Nombre", kind: "string" },
  { key: "lastname", label: "Apellido", kind: "string" },
  { key: "user", label: "Usuario", kind: "string" },
  { key: "phone", label: "Teléfono", kind: "string" },
  { key: "rol", label: "Rol", kind: "string" },
  { key: "birthday", label: "Nacimiento", kind: "date" },
  { key: "createdAt", label: "Registrado", kind: "date" },
];

type UsuarioExportado = {
  name?: string | null;
  lastname?: string | null;
  user?: string | null;
  phone?: string | null;
  birthday?: Date | string | null;
  createdAt?: Date | string | null;
  rol?: { name?: string | null } | null;
};

/**
 * The staff directory as a spreadsheet, a CSV or a document.
 *
 * Unlike its two siblings this one takes no filters beyond the archived tab,
 * and that is not an omission: the Seguridad screen filters, sorts and pages
 * **in the browser** over a directory it holds whole, so there is nothing on
 * the wire for the server to honour. Its button already exported the entire
 * directory rather than the filtered view; the difference now is that the file
 * says so on its second line instead of leaving the reader to guess.
 */
export const exportarUsuarios = handler("exportarUsuarios", async (req: Request, res: Response) => {
  const { format } = req.query;
  if (!esFormato(format)) {
    return res.status(400).json({ message: "Formato no válido. Use «excel», «csv» o «pdf»." });
  }
  const archived = req.query.archived === "true";

  /**
   * The rows are read **inside** the slot, not before it.
   *
   * The slot exists so that only one export is assembling anything at a time,
   * and the first version took it only around `construirFichero` — which left
   * the larger half unprotected. Twenty thousand incidents plus their
   * revisions and observations, all resident, is a bigger peak than the
   * workbook built from them; and ten of those can be in flight at once per
   * person, which is what the budget allows. The report generator resolves
   * only the viewer outside its slot and runs its query inside, for this
   * reason.
   */
  try {
    const fichero = await exportSlot.run(async () => {
    const filas = (await UsuarioModel.findAll({
      order: [["id", "DESC"]],
      attributes: ["id", "name", "lastname", "user", "phone", "birthday", "createdAt"],
      include: [{ model: RolModel, attributes: ["id", "name"] }],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
      limit: MAX_EXPORT_ROWS + 1,
    })).map((fila, i) => {
      const u = fila.toJSON() as UsuarioExportado;
      return {
        n: i + 1,
        name: u.name,
        lastname: u.lastname,
        user: u.user,
        phone: u.phone ?? null,
        rol: u.rol?.name ?? null,
        birthday: u.birthday ?? null,
        createdAt: u.createdAt ?? null,
      };
    });

      return construirFichero({
        formato: format,
        columnas: COLUMNAS_USUARIO,
        filas,
        titulo: archived ? "Usuarios archivados" : "Usuarios",
        subtitulo: subtituloDeFiltros(archived ? ["archivados"] : []),
        sustantivo: ["usuario", "usuarios"],
        hoja: "Usuarios",
      });
    });

    logAction({
      id_usuario: req.user?.id,
      action: "EXPORT_USUARIO",
      entity: "Usuario",
      entity_id: null,
      detail: `Exportó el directorio de ${fichero.filas} usuarios a ${format}`,
      metadata: { formato: format, filas: fichero.filas, bytes: fichero.buffer.length, archivados: archived },
      // Louder than its two siblings, and than most writes. This is the moment
      // the staff directory — names, telephones, birth dates — stops being
      // something behind a session and becomes a file that can be forwarded.
      severity: "warning",
      ip_address: req.ip ?? null,
    });

    return responderFichero(res, fichero);
  } catch (error) {
    if (responderFalloDeExport(res, error)) return;
    throw error;
  }
});

export const searchUsuario = handler("searchUsuario", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempUsuario = await UsuarioModel.findOne({
    where: { id },
    attributes: { exclude: ["pass"] },
    include: [{ model: RolModel }],
  });
  // 404 rather than 200 with `null`. `searchUsuario_user`, a few lines below,
  // has answered 404 since it was written; these two never agreed.
  if (!TempUsuario) return res.status(404).json({ message: "El usuario no existe." });
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
    res.status(201).json(withoutPass(TempUsuario));
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
 * administrator. Username, password and role each have their own endpoint with
 * their own checks, and `id` is not something a request gets to choose.
 */
const EDITABLE_FIELDS = ["name", "lastname", "birthday", "image", "phone"] as const;

/**
 * Needs the Roles module, not merely the right to edit the account — and
 * `creatableFrom` below is the only thing that reads it.
 *
 * **`editableFrom` used to read it too**, which is what let `PUT
 * /api/usuario/:id` write the `id_rol` of somebody else's account. That route
 * is also the one a person edits their own profile through, so it asks for a
 * password once every ten minutes rather than on every request; a role handed
 * out inside that window would be a promotion the attacker keeps under their
 * **own** credentials, and so survives the victim changing their password,
 * `logout-all`, a factor reset and the console rescue. The field left the route
 * instead of the route leaving the window: `PUT /api/usuario/:id/rol` writes it
 * now (`usuarioRol.controller.ts`). That sub-resource used to ask for the
 * password on every request; since the decision of 2026-10-10 it takes the
 * window like every gated route, so the promotion described above is possible
 * inside one — an accepted cost, and the split still keeps the field off the
 * route a person edits their own profile through.
 *
 * It stays on the creation path because an account cannot be born without a
 * role; `POST /api/usuario/` takes the window as well (same decision).
 */
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

function editableFrom(body: unknown): Record<string, unknown> {
  return pick(body, EDITABLE_FIELDS);
}

/**
 * The role is on this list and not on `editableFrom`'s: `createUsuario` has
 * already refused the request outright without the Roles permission, so by the
 * time this runs the role is always allowed — and an account has to be born
 * with one, which is why creating is the one door that still assigns a role
 * alongside everything else.
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

  /**
   * The two blocks below refuse a request; neither is what stops the write any
   * more. `id_rol` is off this route's allowlist entirely — see
   * `ROLE_ASSIGNMENT_FIELDS` — so whatever a body says about a role is dropped
   * before `set()` sees it, whoever sent it. `PUT /api/usuario/:id/rol` is the
   * route that writes one.
   *
   * They stay because "the field is ignored" and "the request is refused" are
   * not the same answer to give. The profile page sends the whole user object
   * back, its own role included, so an unchanged `id_rol` is ordinary traffic
   * and passes both. Asking for a *different* one is somebody reaching for
   * authority through the wrong door, and that earns a refusal — and, without
   * the Roles permission, the same `critical` line in the bitácora
   * `createUsuario` writes for the same reach. Answering 200 to it would leave
   * an attempt at escalation looking exactly like a successful save.
   */
  const requestedRol = (req.body as Record<string, unknown> | undefined)?.id_rol;
  if (!mayAssignRoles && requestedRol !== undefined && Number(requestedRol) !== TempUsuario.dataValues.id_rol) {
    logAction({ id_usuario: loggedUser.id, action: "ROLE_CHANGE_DENIED", entity: "Usuario", entity_id: Number(id), detail: `Intentó cambiar el rol del usuario #${id} sin permiso sobre Roles`, metadata: { from: TempUsuario.dataValues.id_rol, requested: requestedRol }, severity: 'critical', ip_address: req.ip ?? null });
    return res.status(403).json({ message: "Solo un administrador puede cambiar el rol de un usuario." });
  }

  /**
   * `putPermisos`'s precedent, applied to the account instead of the role:
   * the one mistake with no way back is taking away your own access, and
   * nobody else can hand it back to you. This is why the block above checks
   * *permission* and this one checks *whose account it is* — holding
   * `roles.editar` is exactly what lets the block above fall through here.
   * `asignarRol` refuses the same request on the route that can actually
   * perform it.
   *
   * Only when the request is actually asking for a *different* role than the
   * one already on file: the profile page echoes `id_rol` back untouched on
   * every save, and that unchanged value must keep working for everybody,
   * self included — only a real change is the escalation-or-lockout this
   * closes.
   */
  if (
    loggedUser.id === Number(id) &&
    requestedRol !== undefined &&
    Number(requestedRol) !== TempUsuario.dataValues.id_rol
  ) {
    return res.status(403).json({
      message: "No puede cambiar su propio rol. Pídaselo a otro administrador.",
    });
  }

  const patch = editableFrom(req.body);
  const oldImage = TempUsuario.dataValues.image;
  const udv = TempUsuario.dataValues as unknown as Record<string, unknown>;
  const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
  const beforeMeta: Record<string, unknown> = {};
  const afterMeta:  Record<string, unknown> = {};
  // Every field this route may write is a scalar of the profile, so the diff
  // needs nothing but the values themselves. It used to resolve `id_rol` into
  // `{ id, name }` through a second query, because a bitácora entry saying
  // "3 → 1" tells a reader nothing; that resolution moved to `asignarRol`
  // along with the write.
  for (const k of Object.keys(patch)) {
    const bv = udv[k];
    if (bv === undefined) continue;
    if (isPrimVal(bv) && isPrimVal(patch[k])) { beforeMeta[k] = bv; afterMeta[k] = patch[k]; }
  }
  TempUsuario.set(patch);
  await TempUsuario.save();
  // After the save, and only if nothing else names the file. `oldImage` is
  // whatever this row said its portrait was — and this row's value came from a
  // previous PUT, on a route every account may call for itself. Deleting it on
  // the row's word alone let any account name any photograph in the system as
  // "my old portrait" and have the server remove it on the next edit. See
  // `imageRefs.ts`.
  if (oldImage && patch.image && oldImage !== patch.image) {
    void deleteImageIfUnreferenced(oldImage);
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
     * Renaming yourself proves it is you. **The gate on the route proves it;
     * this handler does not, and no longer may.**
     *
     * **Why a username is worth proving anything at all.** It is half of the
     * credential. Change somebody's username and they cannot log in — not
     * because they have forgotten their password, but because they no longer
     * know what name to offer it with. So this operation is worth what a
     * password change is worth. The concrete case is an unattended machine in
     * the office, or the shared field laptop: whoever sits down at a live
     * session renames the account and **locks its owner out of it without
     * knowing the password**. It is repairable — an administrator hands the
     * name back — but nobody understands what happened in the meantime.
     *
     * **Why not on the screen.** Both screens that rename an account used to
     * ask for a password; one of them then sent the change without it, and the
     * other never asked. A confirmation that lives only in the client is
     * optional by definition: whoever does not want to type it uses the other
     * screen, or `curl`. Which of the two is a real gate is settled entirely by
     * where the check runs, and it is not the browser.
     *
     * **So where does it run.** `requireStepUp()` on `PUT /username/:id` in
     * `usuario.routes.ts`. That is strictly more than this handler ever asked:
     * the gate wants the caller's password *or* a factor proved recently, and
     * for an account that has a factor a password alone stops being an
     * acceptable answer — a rule no comparison of `oldPass` here could express.
     * It also opens a ten-minute window, so a run of ordinary edits costs one
     * confirmation instead of one per request.
     *
     * **And this handler asking again is what was removed.** For a self-rename
     * the gate and this block compared the same secret, twice, in one request:
     * once typed into the dialog as `stepup_password`, once typed into the form
     * as `oldPass`. That double prompt is the complaint the whole
     * reauthentication design started from. `oldPass` arriving from a tab
     * opened before the change is not read.
     *
     * **`updateUserPass` below keeps its own comparison, and the difference is
     * not an inconsistency.** There, "current password" is not a proof of
     * identity: it is half of what is being changed, and typing it is the
     * operation. Isaias, 2026-09-08.
     */

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
      // 400, not 401. The frontend reads every 401 as "the session is dead"
      // and logs out — which is right for the other fourteen 401s in this API,
      // all of them about the session — so a mistyped current password threw
      // the person to the login screen with "Tu sesión se cerró". It was the
      // only 401 here that was not about the session.
      //
      // The flag is what keeps the guess from becoming free: the budget on
      // this route charges by status, 401 only, and `confirmCostsNothing`
      // reads this to charge a refusal that is not one.
      res.locals.stepUpPasswordWrong = true;
      return res.status(400).json({ message: CURRENT_PASSWORD_WRONG_MESSAGE });
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
   * 🔴 **`estado` is decided here the way a login decides it, and is no longer
   * carried across from the session making the request.**
   *
   * This is the only place in `src/` outside the two login doors that opens a
   * session, and copying the caller's own `estado` onto the new row made it a
   * way round the fourteen-day deadline. The new row is created **now**, and
   * `estadoEfectivo` exempts a `completa` session opened after its account's
   * deadline had already passed — such a row can normally only have got there
   * by proving a factor. So a `completa` session past its deadline could write
   * itself a fresh, exempt `completa` session, and do it again before the
   * thirty-day ceiling ran out, for ever, on an account with no second factor.
   * Nobody would have taken that road while the login handed out fourteen new
   * days for registering a passkey and deleting it; with that loop closed
   * (`auth/sessionPromotion.ts`'s tombstone), it is the road that is left.
   *
   * 🔴 **An account that has a factor keeps `completa`, and that is not a
   * softening of the rule — it is what the route's own gate already
   * guarantees.** `estadoInicialDeSesion` answers `parcial` for any account
   * with a factor, because a login has proved no factor yet. This is not a
   * login: `requireStepUp()` on this route lets an account
   * *with* a factor past only on an `mfa_satisfied_at` newer than
   * `STEP_UP_WINDOW_MINUTES`, so everybody here who has a factor proved it
   * minutes ago. Writing `parcial` anyway would have `authenticate` answer 401
   * to their very next request — the browser thrown back to the login form by
   * the same response that says the password changed, which is precisely the
   * failure this rotation was built to prevent.
   *
   * What is left after that is the account with **no** factor, which is the
   * one the deadline is about, and it gets exactly what its next login would
   * give it: `completa` inside the grace period, `onboarding` once it is over.
   * `onboarding` is not a lockout — it opens the doors that lead to
   * registering a factor and answers `FACTOR_PENDIENTE` for the rest.
   *
   * **`graceUntil` is written here too, for the same reason the login writes
   * it.** A non-null answer means this account has no usable deadline stored,
   * so the clock has to start; leaving that to the next login would let
   * somebody whose column is NULL — after the documented manual reprieve, say
   * — hold the ERP indefinitely by rotating their session and never logging in
   * again. Best-effort and after the session exists, exactly as
   * `terminarLogin` does it: the password is already committed by this line,
   * so a failed stamp is logged and swallowed, and the next login retries it.
   */
  if (isSelf) {
    try {
      // Inside the `try` on purpose: these are two more queries, and a
      // rejection here must reach the same swallowed failure as one from
      // `issueSession`. Thrown, it would answer 500 about a password that
      // has already changed — the exact retry trap the paragraph above
      // describes.
      const { estado, graceUntil, conFactor } = await estadoInicialDeSesion(
        // The caller's own row: `isSelf` is what makes `TempUsuario` the same
        // account as `loggedUser`, and it was read with every column, so the
        // deadline needs no second query.
        { id: loggedUser.id, mfa_grace_until: TempUsuario.dataValues.mfa_grace_until },
        new Date(),
      );
      await issueSession(req, res, loggedUser.id, conFactor ? "completa" : estado);
      if (graceUntil !== null) {
        // Its own `catch`, and after the session exists, for the two reasons
        // `terminarLogin` gives: a deadline must never start on a request that
        // failed to hand out a session, and a failure here must not cost the
        // caller the cookie they have just been given. The column stays NULL,
        // so the next login takes the same branch and tries again.
        try {
          await UsuarioModel.update({ mfa_grace_until: graceUntil }, { where: { id: loggedUser.id } });
        } catch (err) {
          logAction({ id_usuario: loggedUser.id, action: "MFA_GRACE_START_FAILED", entity: "Usuario", entity_id: loggedUser.id, detail: "Rotó la sesión al cambiar su contraseña, pero no se pudo iniciar el plazo de gracia: mientras la columna siga vacía el ERP no se cerrará nunca para esta cuenta", metadata: { error: err instanceof Error ? err.message : String(err), graceUntil }, severity: 'warning', ip_address: req.ip ?? null });
        }
      }
    } catch (err) {
      logAction({ id_usuario: loggedUser.id, action: "SESSION_ROTATION_FAILED", entity: "Usuario", entity_id: loggedUser.id, detail: "Cambió su contraseña, pero no se pudo abrir la sesión nueva", metadata: { error: err instanceof Error ? err.message : String(err) }, severity: 'warning', ip_address: req.ip ?? null });
    }
  }

  logAction({ id_usuario: req.user?.id, action: "CHANGE_PASSWORD", entity: "Usuario", entity_id: Number(id), detail: isSelf ? "Cambió su contraseña" : `Cambió contraseña del usuario #${id}`, metadata: { target_user_id: Number(id), self: isSelf, sesiones_revocadas: revocadas, dispositivos_revocados: dispositivos }, severity: 'critical', ip_address: req.ip ?? null });
  res.status(200).json(withoutPass(TempUsuario));
});
const CON_TRAMOS_A_CARGO =
  "Este usuario es encargado de tramos. Quítelo de esos tramos para poder archivarlo.";

/** The tramo ids of `?liberarTramos=14,15`, or null when absent or unreadable. */
const leerTramosVistos = (valor: unknown): Set<number> | null => {
  if (typeof valor !== "string" || !/^\d+(,\d+)*$/.test(valor)) return null;
  return new Set(valor.split(",").map(Number));
};

/** One `UPDATE_TRAMO` per tramo an archive released, as the tramo card would have logged it. */
const logTramosLiberados = (actor: number | undefined, tramos: readonly TramoPresentado[]) => {
  for (const t of tramos) {
    logAction({
      id_usuario: actor, action: "UPDATE_TRAMO", entity: "Tramo", entity_id: t.id,
      detail: `Editó tramo ${t.nombre}`,
      metadata: {
        before: {
          name: t.nombre, departamento: t.departamento?.name ?? null,
          encargado: t.encargado?.nombre ?? null, id_encargado: t.id_encargado,
        },
        after: { name: t.nombre, departamento: t.departamento?.name ?? null, encargado: null, id_encargado: null },
        motivo: "encargado archivado",
      },
      severity: "warning",
    });
  }
};

export const deleteUsuario = handler("deleteUsuario", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await can(req.user?.id_rol, "seguridad", "archivar"))) {
    return res.status(403).json({ message: "No tienes permiso para eliminar usuarios." });
  }

  /**
   * Refuses `Number(id) === req.user.id`, the same shape `rescatarMfaDeUsuario`
   * below already uses for the same reason: after the permission check, never
   * before, so somebody who lacks `seguridad.archivar` learns nothing from the
   * message about whether the id they tried happened to be their own.
   *
   * This is the heavier case. Archiving is `UsuarioModel`'s soft delete — the
   * row survives with a `deletedAt` — but the transaction below also revokes
   * every session and every remembered device the caller has, so the very
   * next request finds nobody logged in. And unlike a reset second factor,
   * there is no door back that does not already require what was just given
   * up: `desarchivarUsuario` demands `seguridad.archivar` itself — the
   * permission the caller may have just disarmed on their own account — the
   * in-app rescue answers 409 "cuenta archivada", and the rescue console has
   * no order today to undo an archive either. The only way out left is an
   * `UPDATE` by hand against production.
   */
  if (req.user && Number(id) === req.user.id) {
    return res.status(403).json({
      message: "No puede archivar su propia cuenta. Pídaselo a otro administrador.",
    });
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
   *
   * **And the tramos the person is in charge of, released or refused.** An
   * archived encargado would stay on the general report with nobody behind
   * the name, so archiving them is refused (409, with the list) unless the
   * request names, in `?liberarTramos=14,15`, exactly the tramos the person
   * carries: the ones the archive dialog showed. A different set — a tramo
   * assigned while the dialog was open — is refused with the new list, so
   * nothing is released that nobody saw. Archived tramos count and are
   * released too: a tramo restored later must not come back with an archived
   * encargado. Un-archiving does not give the tramos back.
   *
   * The account's row is locked FOR UPDATE first. `updateTramo` checks a new
   * encargado under a share lock on the same row (`encargadoVivo`), so an
   * assignment either lands before this look or waits and finds the account
   * archived; it cannot slip in between the look and the archive.
   */
  const vistos = leerTramosVistos(req.query.liberarTramos);
  const resultado = await sequelize.transaction(async (transaction) => {
    await UsuarioModel.findByPk(Number(id), { attributes: ["id"], transaction, lock: true });
    const aCargo = await TramoModel.findAll({
      where: { id_encargado: Number(id) }, paranoid: false, transaction,
      attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
    });
    const tramos = aCargo.map(presentarTramo);
    const coinciden = vistos !== null && vistos.size === tramos.length && tramos.every((t) => vistos.has(t.id));
    if (tramos.length > 0 && !coinciden) return { aCargo: tramos } as const;
    if (tramos.length > 0) {
      await TramoModel.update(
        { id_encargado: null },
        { where: { id: tramos.map((t) => t.id) }, paranoid: false, transaction },
      );
    }
    await UsuarioModel.destroy({ where: { id }, transaction });
    const sesiones = await revokeAllSessionsOf(Number(id), { transaction });
    const dispositivos = await revokeAllRememberedDevicesOf(Number(id), { transaction });
    return { sesiones, dispositivos, liberados: tramos };
  });
  if ("aCargo" in resultado) {
    return res.status(409).json({ message: CON_TRAMOS_A_CARGO, tramos: resultado.aCargo });
  }
  logAction({ id_usuario: req.user?.id, action: "DELETE_USUARIO", entity: "Usuario", entity_id: Number(id), detail: `Archivó usuario #${id}`, metadata: { sesiones_revocadas: resultado.sesiones, dispositivos_revocados: resultado.dispositivos, tramos_liberados: resultado.liberados.length }, severity: 'critical' });
  logTramosLiberados(req.user?.id, resultado.liberados);
  return res.status(204).end();
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
  return res.status(204).end();
});
/**
 * `POST /usuario/:id/mfa/reset` — the in-app half of §8's "vía de escape":
 * an administrator clears somebody else's second factor from the browser,
 * in thirty seconds, instead of that person being locked out until whoever
 * has console access to the production container gets to a keyboard.
 *
 * A thin translation of an HTTP request onto `restablecerSegundoFactor`
 * (`auth/rescueCore.ts`) and nothing more — every rule that matters (H1's
 * grace that never shrinks, H2's lockout lifted alongside the factors,
 * H6-bis's sessions and remembered devices revoked together, the mandatory
 * notice before anything is touched, the audit line that survives a
 * rollback) lives there, once, shared with `--reset-mfa` on the console
 * script. This handler owns exactly two things that are its own: the
 * permission/step-up gate below (`usuario.routes.ts`), and the refusal
 * right after it.
 *
 * **Refuses `:id === req.user.id` — Isaias's decision, not a default, and
 * not merely "unwise".** This route's whole job is to leave its target with
 * *zero* registered factors, and what that costs the caller's own session is
 * a downgrade of everything `requireStepUp` (`middleware/requireStepUp.ts`)
 * asks of it afterwards. With a factor on the account the gate demands that
 * factor proved in the last ten minutes (`mfa_satisfied_at`); with no factor
 * left it demands the password alone, and one correct password then opens ten
 * minutes for every gated route (`password_confirmed_at`). So doing this to
 * yourself trades "something you hold" for "something you know" as the only
 * thing the gate asks of your own session — it spends your own second factor
 * to make your own session cheaper to use, which is the opposite of what an
 * escape hatch is for. (Before the decision of 2026-10-10 the refusal was
 * written as "the factor **and** the password to the password alone"; the
 * "and" is gone, since no route asks for both any more, but the downgrade from
 * the factor to the password alone is real and is what remains.) The console (`--reset-mfa`
 * run with a shell inside the production container) is the deliberate way to
 * reset your own factors instead — it does not go through this gate, or any
 * session, at all.
 */
export const rescatarMfaDeUsuario = handler("rescatarMfaDeUsuario", async (req: Request, res: Response) => {
  const { id } = req.params;
  const targetId = Number(id);

  if (req.user && targetId === req.user.id) {
    return res.status(403).json({
      message:
        "No puede restablecer su propio segundo factor desde el panel. Use la consola de rescate del servidor.",
    });
  }

  // Named for the notice email and the bitácora `metadata`, not for anything
  // this handler decides with — `req.user.id` alone would already be enough
  // to trace, but `@user` is what a human reading the alert can act on
  // without a second lookup.
  const admin = req.user ? await UsuarioModel.findByPk(req.user.id, { attributes: ["user"] }) : null;
  const actor: ActorRescate = {
    descripcion: `endpoint: @${admin?.dataValues.user ?? "?"} (id ${req.user?.id ?? "?"})`,
    ip: req.ip ?? null,
  };

  const resultado = await restablecerSegundoFactor(targetId, actor);

  if (!resultado.ok) {
    if (resultado.motivo === "no-encontrada") {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }
    // "archivada": the row exists but is soft-deleted — `usuario.model.ts`
    // is `paranoid`, so an ordinary lookup would have answered 404 about an
    // account that is very much on file. Same wording `resolverCuentaDeRescate`
    // gives the console for the same case, so the two doors do not describe
    // one condition two different ways.
    return res.status(409).json({
      message: `La cuenta @${resultado.user} está archivada. Desarchívela antes de restablecer su segundo factor.`,
    });
  }

  // Plan 4E: the reset deletes credentials and leaves the verified address,
  // which is a factor on its own — so for that account the sentence "ya puede
  // entrar solo con su contraseña" would be false, and the person reading
  // this has to know what to do if the *mailbox* is what was lost.
  const { correoVerificado } = resultado.datos;
  return res.status(200).json({
    message: correoVerificado
      ? `Segundo factor restablecido para @${resultado.cuenta.user}: se borraron sus aplicaciones, llaves ` +
        "y códigos. Su correo verificado sigue siendo su segundo factor, así que al entrar se le pedirá " +
        "un código por correo. Si lo que perdió es el acceso a ese buzón, hay que cambiarle la " +
        "dirección desde la consola de rescate (--set-email) o borrársela (--clear-email)."
      : `Segundo factor restablecido para @${resultado.cuenta.user}.`,
    correo_es_factor: correoVerificado,
    sesiones_revocadas: resultado.datos.sesionesRevocadas,
    dispositivos_revocados: resultado.datos.dispositivosRevocados,
    gracia_hasta: resultado.datos.graceUntil,
  });
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
    return res.status(204).end();
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
