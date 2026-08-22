// The session endpoints: getting in, finding out who you are, and getting out.
//
// Everything here answers about the caller and only the caller. There is no
// route in this file that takes a user id from the request, and that is
// deliberate: the id always comes from `req.user`, which `authenticate` filled
// in from the credential. The one route that does take something from the URL
// — `DELETE /sessions/:id` — combines it with `req.user.id` in the same query
// rather than trusting it.
//
// What is *not* here: the credential check itself. Both this file's `login` and
// the old `POST /api/login` call `verifyCredentials`, which holds the uniform
// message, the levelled timings, the account lockout and the cost re-hash. Two
// copies of that would have drifted, and the part most likely to be left out of
// the second copy is the lockout, because a successful login looks identical
// with and without it.

import type { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { permissionsFor } from "../permissions/store.js";
import { verifyCredentials } from "../auth/credentials.js";
import { issueSession } from "../auth/issueSession.js";
import { clearSessionCookie } from "../auth/sessionCookie.js";
import {
  listSessionsOf,
  revokeAllSessionsOf,
  revokeSession,
  revokeSessionOf,
} from "../auth/sessionStore.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";

const authLog = log("auth");

const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";
/** Twin of the message in `authenticate.ts`; both mean the row is gone. */
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";
/**
 * What a request authenticated by the old JWT is told when it asks for
 * something only a session row can answer.
 *
 * It is a 400 and not a 500: there is nothing broken here. A bearer token has
 * no row behind it, which is legitimate for as long as the transition lasts,
 * and the way out is to log in again — which is what this says.
 */
const SIN_FILA_DE_SESION =
  "Esta sesión es del sistema anterior y no se puede cerrar desde aquí. Vuelva a iniciar sesión.";
/** One answer for "not yours", "never existed" and "already closed". */
const SESION_NO_ENCONTRADA = "Esa sesión no existe o ya se cerró.";

/**
 * The shape of a session id, checked before it reaches Postgres.
 *
 * `sesiones.id` is a `UUID` column. Postgres does not return "no rows" for
 * `WHERE id = 'pepito'`, it raises 22P02 — invalid input syntax for type uuid —
 * so without this, any authenticated caller could turn a `DELETE
 * /api/auth/sessions/anything` into a 500 with a stack trace in the log.
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One place that turns an unexpected failure into a 500.
 *
 * Every handler below is `async`, and Express 4 does not catch a rejected
 * promise from one: it never reaches the terminal handler in `app.ts`, the
 * request just hangs until the client gives up. So each handler is wrapped
 * rather than each one remembering its own try/catch — and the message the
 * client sees is the same one `app.ts` and `authenticate.ts` use, instead of
 * whatever a database driver happened to say.
 */
function handler(name: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  const wrapped = async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      authLog.error({ err, ruta: req.originalUrl }, `fallo en ${name}`);
      if (!res.headersSent) {
        res.status(500).json({ message: ERROR_INESPERADO });
      }
    }
  };
  // The name survives the wrapper because `routeGuards.test.ts` reads the
  // handler names off the assembled app to tell a gated route from an open one.
  Object.defineProperty(wrapped, "name", { value: name });
  return wrapped;
}

/**
 * Who the caller is, according to the credential `authenticate` already checked.
 *
 * Every handler asks for this rather than reading `req.user` and hoping. The
 * three "IDOR protection" guards in `usuario.controller.ts` used to be written
 * `if (loggedUser && …)`, which *skips* the check when there is no session
 * instead of refusing — unreachable behind `authenticate`, and still the wrong
 * shape. A guard that only works because another guard ran is not a guard.
 */
function callerOf(req: Request): { id: number; id_rol: number; id_sesion?: string } | null {
  return req.user ?? null;
}

/**
 * `POST /api/auth/login` — the new front door.
 *
 * The difference from `POST /api/login` is the whole plan in one line: the
 * credential goes back as an httpOnly cookie and **not** in the body. A token
 * in the body is a token in JavaScript's reach, which is a token any script on
 * the page can read and one that nothing can revoke.
 *
 * The body still carries the user and their permissions, exactly as the old
 * endpoint does minus the token, so the first screen after logging in is
 * already right instead of flashing everything and then hiding what this role
 * cannot reach.
 *
 * A bad credential is 400 and not 401, matching the old door. A 401 from the
 * login endpoint itself is the status every frontend interceptor reads as
 * "session expired, go to the login screen" — from the login screen, that is a
 * loop.
 */
export const login = handler("login", async (req: Request, res: Response) => {
  const check = await verifyCredentials({
    user: (req.body as { user?: unknown } | undefined)?.user,
    pass: (req.body as { pass?: unknown } | undefined)?.pass,
    ip: req.ip ?? null,
  });
  if (!check.ok) {
    return res.status(400).json({ message: check.message });
  }

  // Not best-effort here, unlike the old door: without a session there is no
  // credential at all, so a failure to open one has to fail the login rather
  // than answer 200 to a browser that would then be refused everywhere.
  await issueSession(req, res, check.usuario.id);

  const permisos = await permissionsFor(check.usuario.id_rol);
  return res.status(200).json({ usuario: check.usuario, permisos, message: "Login exitoso" });
});

/**
 * `GET /api/auth/me` — who I am, now.
 *
 * Read from the database and not from the credential. Under the old token this
 * answered with the token's own payload, which is a photograph taken the day
 * the person logged in: somebody moved from Coordinador to Cliente kept a
 * browser that believed it was still a Coordinador for the rest of the week,
 * and since the interface draws itself from this answer, they kept seeing
 * buttons they were no longer meant to have.
 *
 * The attributes are listed one by one rather than excluding `pass`. The next
 * plan adds `email`, `mfa_grace_until` and `webauthn_challenge` to these
 * tables; an exclusion list publishes every one of them the day it lands.
 */
export const me = handler("me", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const found = await UsuarioModel.findByPk(caller.id, {
    attributes: ["id", "id_rol", "user", "name", "lastname", "image"],
  });
  // Archived between `authenticate` and here. A narrow race, and the answer is
  // the same as authenticate's: the session is over.
  if (!found) return res.status(401).json({ message: CUENTA_INACTIVA });

  const usuario = found.dataValues;
  return res.status(200).json({ usuario, permisos: await permissionsFor(usuario.id_rol) });
});

/**
 * `POST /api/auth/logout` — end this session.
 *
 * This one, not all of them. Somebody who logs out on the office computer has
 * not asked to be logged out on their phone, and a logout that closed
 * everything would make the button in the corner of the screen do something
 * nobody expects.
 *
 * The cookie is cleared as well as the row revoked. Either alone is a
 * half-logout: the row without the cookie leaves the browser sending a dead
 * credential and collecting 401s, and the cookie without the row leaves a
 * working session for anyone who kept a copy of the token.
 */
export const logout = handler("logout", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  // No row to revoke: this request arrived with the old bearer token. Saying so
  // is better than pretending it worked, because a JWT stays valid either way
  // and only logging in again produces something revocable.
  if (!caller.id_sesion) {
    return res.status(400).json({ message: SIN_FILA_DE_SESION });
  }

  await revokeSession(caller.id_sesion);
  clearSessionCookie(res);
  logAction({ id_usuario: caller.id, action: "LOGOUT", entity: "Usuario", entity_id: caller.id, detail: "Cerró la sesión de este dispositivo", metadata: { id_sesion: caller.id_sesion }, severity: 'info', ip_address: req.ip ?? null });
  return res.status(200).json({ message: "Sesión cerrada." });
});

/**
 * `POST /api/auth/logout-all` — end every session I have.
 *
 * The button for "I lost my laptop", and the one thing the JWT could never do.
 * It works on the old path too: revocation is by user id, so a request that
 * arrived with a bearer token still closes every session row that account has
 * — its own token stays valid until it expires, which is the hole this plan
 * documents rather than the one it can close today.
 */
export const logoutAll = handler("logoutAll", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const cerradas = await revokeAllSessionsOf(caller.id);
  clearSessionCookie(res);
  logAction({ id_usuario: caller.id, action: "LOGOUT_ALL", entity: "Usuario", entity_id: caller.id, detail: `Cerró todas sus sesiones (${cerradas})`, metadata: { sesiones_revocadas: cerradas }, severity: 'warning', ip_address: req.ip ?? null });
  return res.status(200).json({ message: "Se cerraron todas sus sesiones.", cerradas });
});

/**
 * `GET /api/auth/sessions` — the devices I am logged in on.
 *
 * Projected field by field instead of handing back the rows. `listSessionsOf`
 * already excludes `token_hash`, but this table grows: the next plan adds
 * `webauthn_challenge`, `mfa_source` and `estado` to it, and a spread would
 * publish all three the day the migration runs.
 *
 * `actual` is what the screen needs to say "this device" and to warn before
 * closing the session doing the asking. A request on the old bearer path has no
 * session row, so nothing is marked current — that is honest and needs no error:
 * the list of sessions is still exactly right.
 */
export const sessions = handler("sessions", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const rows = await listSessionsOf(caller.id);
  return res.status(200).json({
    sesiones: rows.map((s) => ({
      id: s.id,
      user_agent: s.user_agent,
      ip_address: s.ip_address,
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      expires_at: s.expires_at,
      actual: s.id === caller.id_sesion,
    })),
  });
});

/**
 * `DELETE /api/auth/sessions/:id` — close one of my sessions.
 *
 * The IDOR surface of this plan. The id comes from the URL, which the caller
 * writes, so it is never used alone: `revokeSessionOf` puts `id_usuario` in the
 * same `where`. This repository has already shipped a `:id` route that trusted
 * the URL — `PUT /usuario/:id` passed the body straight to `set()`, so any
 * account could send `{ id_rol: 1 }` at its own id and come back an
 * administrator — and a `DELETE /:id` with no owner filter is the same shape.
 *
 * 404 for every refusal, and never 403. A 403 says "this session exists and it
 * is somebody's", which turns the endpoint into a way of enumerating who is
 * logged in right now.
 */
export const endSession = handler("endSession", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const id = req.params.id;
  // Same 404 as a session that is not yours: from the caller's side a malformed
  // id and a stranger's id are both "no such session of mine", and answering
  // differently would be one more thing to measure.
  if (typeof id !== "string" || !ES_UUID.test(id)) {
    return res.status(404).json({ message: SESION_NO_ENCONTRADA });
  }

  const cerrada = await revokeSessionOf(caller.id, id);
  if (!cerrada) {
    return res.status(404).json({ message: SESION_NO_ENCONTRADA });
  }

  // Closing the session you are asking from is allowed — it is the same act as
  // logging out — but then the cookie has to go too, or the browser keeps
  // sending a revoked token and collecting 401s with no way to tell why.
  if (id === caller.id_sesion) {
    clearSessionCookie(res);
  }
  logAction({ id_usuario: caller.id, action: "SESSION_REVOKED", entity: "Usuario", entity_id: caller.id, detail: "Cerró una de sus sesiones", metadata: { id_sesion: id, era_la_actual: id === caller.id_sesion }, severity: 'info', ip_address: req.ip ?? null });
  return res.status(200).json({ message: "Sesión cerrada." });
});
