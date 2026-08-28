// The session endpoints: getting in, finding out who you are, proving you are
// still you, and getting out.
//
// Everything here answers about the caller and only the caller. There is no
// route in this file that takes a user id from the request, and that is
// deliberate: the id always comes from `req.user`, which `authenticate` filled
// in from the credential. The one route that does take something from the URL
// — `DELETE /sessions/:id` — combines it with `req.user.id` in the same query
// rather than trusting it.
//
// What is *not* here: the credential check itself. `login` calls
// `verifyCredentials`, which runs the comparison in `auth/credentials.ts` — the
// uniform message, the levelled timings, the account lockout and the cost
// re-hash. The second door onto that comparison is `verifyOwnPassword`, and its
// caller is `updateUserName` in `usuario.controller.ts` rather than anything in
// this file: `POST /confirm-password` used to be it, and is retired — see
// `auth.routes.ts` for why asking before the operation was the wrong shape.
// What the two doors do differently is two named arguments and no difference in
// code, which is the whole reason the comparison is one function.
//
// There used to be a second copy of the whole endpoint. `POST /api/login` had
// its own handler in `controllers/login.controller.ts` — same checks, same body
// minus a JWT, its own 503 — and the two were kept in step by hand for the
// length of the migration. That handler is gone, and so is the file: what was
// left of it after the merge was a JWT verifier behind `GET /api/login`, and
// that went too. The old address is now mounted on `login` below, so there is
// one implementation behind both URLs and nothing left to keep in step. See
// `login.routes.ts` for what still answers there and when it can go.

import type { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { permissionsFor } from "../permissions/store.js";
import { logLogin, verifyCredentials } from "../auth/credentials.js";
import { issueSession } from "../auth/issueSession.js";
import { estadoInicialDeSesion } from "../auth/factorInventory.js";
import { purgeExpiredTokens } from "../auth/tokenStore.js";
import { clearSessionCookie } from "../auth/sessionCookie.js";
import {
  listSessionsOf,
  revokeAllSessionsOf,
  revokeSessionOf,
} from "../auth/sessionStore.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const authLog = log("auth");
const handler = makeHandler(authLog);

/**
 * What somebody is told when their password was right and the server still
 * could not let them in.
 *
 * Deliberately not beside `CREDENCIALES_INVALIDAS` and
 * `CREDENCIALES_INCOMPLETAS` in `config/security.ts`, and the line is worth
 * drawing: those two are a pair about the *credential*, kept together precisely
 * so nobody rewords one without seeing the other and leaks which usernames
 * exist. This says nothing about the account — it is about this server, right
 * now — so it belongs to the endpoint.
 *
 * "In a few minutes" is the whole point of the wording: the two ways to get
 * here are an exhausted connection pool and a locked `sesiones` table, and both
 * pass. Retyping the password will not help and the person needs to be told
 * that rather than left to conclude they have forgotten it.
 *
 * It arrived on the old `POST /api/login` first and moved here when the two
 * doors were merged, because the alternative was losing it: `handler()` below
 * turns every rejection into a 500, and a 500 tells the person nothing they can
 * act on.
 */
const SESION_NO_DISPONIBLE =
  "No se pudo iniciar la sesión en este momento. Inténtelo de nuevo en unos minutos.";
/** Twin of the message in `authenticate.ts`; both mean the row is gone. */
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";
/** One answer for "not yours", "never existed" and "already closed". */
const SESION_NO_ENCONTRADA = "Esa sesión no existe o ya se cerró.";

/**
 * The shape of a session id, checked before it reaches Postgres.
 *
 * `sesiones.id` is a `UUID` column. Postgres does not return "no rows" for
 * `WHERE id = 'pepito'`, it raises 22P02 — invalid input syntax for type uuid —
 * so without this, any authenticated caller could turn a `DELETE
 * /api/auth/sessions/anything` into a 500 with a stack trace in the log.
 *
 * No `i` flag, and that is not an oversight: the id is lower-cased before it
 * gets here. Should that normalisation ever be removed, an upper-case id fails
 * this check and gets a clean 404, instead of quietly taking the path that used
 * to revoke the row and leave the cookie behind.
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Who the caller is, according to the credential `authenticate` already checked.
 *
 * Every handler asks for this rather than reading `req.user` and hoping. The
 * three "IDOR protection" guards in `usuario.controller.ts` used to be written
 * `if (loggedUser && …)`, which *skips* the check when there is no session
 * instead of refusing — unreachable behind `authenticate`, and still the wrong
 * shape. A guard that only works because another guard ran is not a guard.
 *
 * The shape is taken from `Request["user"]` rather than written out again, and
 * that is not tidiness. Written out, this signature was the one place where the
 * two session fields stayed optional after `app.ts` made them required — every
 * handler below reads the caller through here, so a hand-copied type would go
 * on offering `id_sesion` as possibly-absent and keep every dead branch in this
 * file compiling. Derived, there is one declaration to change instead of two
 * that can disagree.
 */
function callerOf(req: Request): NonNullable<Request["user"]> | null {
  return req.user ?? null;
}

/**
 * The front door. `POST /api/auth/login`, and `POST /api/login` too — the old
 * address is mounted on this same function, so there is one login in the API
 * however it is addressed.
 *
 * What it does that the retired handler did not: the credential goes back as an
 * httpOnly cookie and **only** as a cookie. The old one signed a seven-day JWT
 * and put it in the body as well, which is a credential in JavaScript's reach —
 * readable by any script on the page — and one that no revocation reaches,
 * because the browser keeps its own copy and the server has no row to close.
 * That is the defect the whole arc exists to remove.
 *
 * The body carries the user and their permissions and nothing else, so the
 * first screen after logging in is already right instead of flashing everything
 * and then hiding what this role cannot reach.
 *
 * A bad credential is 400 and not 401. A 401 from the login endpoint itself is
 * the status every frontend interceptor reads as "session expired, go to the
 * login screen" — from the login screen, that is a loop.
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

  /**
   * Which of the three states this session opens in, decided before it is
   * opened. `graceUntil` comes back non-null only when this is the first
   * login this account has ever made past the MFA migration, and it means
   * "stamp this deadline on them" — see the write below the try/catch.
   *
   * Outside the try, and that is on purpose: what the 503 below means is "the
   * session could not be opened", and widening it to cover this would make
   * the status say something it does not mean. A database failure here
   * behaves exactly like a database failure in `verifyCredentials` one line
   * above — it propagates, and `handler()` answers 500 — which is the
   * behaviour a login has had all along when the database is unreachable.
   *
   * `mfa_grace_until` rides beside `check.usuario` rather than inside it
   * because `UsuarioAutenticado` is published verbatim in the response body;
   * see `ResultadoCredenciales` in `auth/credentials.ts`.
   */
  const ahora = new Date();
  const { estado, graceUntil } = await estadoInicialDeSesion(
    { id: check.usuario.id, mfa_grace_until: check.mfa_grace_until },
    ahora,
  );

  /**
   * A session this endpoint cannot open is a login it cannot grant. There is
   * no credential other than the cookie, so a 200 without one tells the
   * browser "Bienvenido", navigates the person into the ERP, gets 401 on the
   * first request for data, and puts them back on the login form with nothing
   * on screen to explain it — identically on every retry, because what is
   * broken is the database and not anything they typed.
   *
   * **Caught here rather than left to `handler()`, and that is the whole point
   * of the try/catch below.** The wrapper would turn the rejection into a 500 and
   * `ERROR_INESPERADO`, which says "something is wrong with the software" when
   * the truth is "a dependency is down, come back shortly". 503 is what this
   * is, and the sentence reaches the screen: `web`'s `Login.api.ts` reads
   * `data.message` off any non-2xx answer and hands it to the form. This is
   * the half the retired `POST /api/login` handler got right, kept on the way
   * through rather than dropped — losing it would have made the merge a
   * regression for the one failure a person can actually do something about.
   *
   * **What this cannot do is lock anybody out.** The per-account lockout
   * counter only moves inside `verifyCredentials` on a wrong password, so a
   * database outage never touches it. Neither do the rate-limit buckets:
   * `costsNothing` in `loginLimiters.ts` refunds the whole 5xx range, so an
   * outage during the morning rush does not spend a budget that behind the
   * office's NAT is one key for the entire building. Its comment has the
   * reasoning, including why that cannot be turned into a free guess.
   */
  try {
    // The state is decided above and passed explicitly, rather than left to a
    // default inside `issueSession`: which doors a session opens is the login's
    // decision to make and the storage layer's to record, and a default there
    // would be the kind that stays correct until the day somebody adds a
    // second caller.
    await issueSession(req, res, check.usuario.id, estado);
  } catch (err) {
    authLog.error(
      { err, id_usuario: check.usuario.id },
      "no se pudo abrir la sesión de cookie: se rechaza el login, porque la cookie es la única credencial",
    );
    return res.status(503).json({ message: SESION_NO_DISPONIBLE });
  }

  /**
   * The grace clock starts here, after the session and never before it.
   *
   * Written first, this would start somebody's fourteen days on a request
   * that ended in the 503 above — a deadline running from a login they never
   * got, and days they had no way to spend, since there is no screen to
   * configure anything on without a session.
   *
   * **What happens when this write fails, decided rather than defaulted.** It
   * is caught, written to the log, and the login still answers 200. Three
   * things settle that:
   *
   * - **Failing the login would be a lie and a worse outcome.** By this point
   *   `issueSession` has already set the cookie and the session row exists.
   *   Answering 503 now would send somebody back to the login form holding a
   *   perfectly good session, and they would log in again — into the same
   *   failing UPDATE.
   * - **It is not lost, and this is the part worth knowing.** The column stays
   *   null, so the *next* login runs `estadoInicialDeSesion` against a null
   *   deadline, takes the same branch and tries the same write again. The
   *   retry is the next login, and it costs nothing to wait for it. What a
   *   failure actually costs is that this account's fourteen days start from
   *   a later login than they should have — generous, never premature, and
   *   never a lockout.
   * - **A failure that keeps repeating is not survivable in silence**, because
   *   the thing that stops working is the ERP's ability to ever close on
   *   anybody: `mfa_grace_until` null for ever is `completa` for ever. So it
   *   is logged at `error` with the sentence spelling that out, rather than
   *   at `warn` where it would read as noise. That matches how this handler
   *   already treats the other write it must not fail on — `purgeExpiredTokens`
   *   below is fire-and-forget with a logged error, for the same reason.
   *
   * Awaited rather than fire-and-forget, which is where it differs from that
   * purge: this one runs at most once in an account's lifetime, so it is not
   * latency charged to every login, and the ordering it guarantees is what
   * `login.session.test.ts` asserts when it pins the write as happening after
   * the session and not before.
   */
  if (graceUntil !== null) {
    try {
      await UsuarioModel.update(
        { mfa_grace_until: graceUntil },
        { where: { id: check.usuario.id } },
      );
    } catch (err) {
      authLog.error(
        { err, id_usuario: check.usuario.id, graceUntil },
        "no se pudo iniciar el plazo de gracia de MFA: la sesión sigue abierta y el próximo login lo reintenta, pero mientras la columna siga vacía el ERP no se cerrará nunca para esta cuenta",
      );
    }
  }

  const permisos = await permissionsFor(check.usuario.id_rol);
  // Last, not first. Written before the session existed, this line would claim
  // somebody logged in on a request that answered 500.
  logLogin(check.usuario, req.ip ?? null);
  /**
   * The opportunistic cleanup `token_uso_unico` relies on instead of a cron
   * job — see `tokenStore.ts`. A login happens constantly and for free,
   * which is exactly what a table with no scheduled purge needs.
   *
   * Fire-and-forget, on purpose: this is housekeeping for a table this
   * request never touched, so it must not add latency to the response
   * somebody is waiting on, and a failure in it must not turn a successful
   * login into a 500. The failure is still reported rather than swallowed,
   * so a purge that stops working is visible in the logs before the table
   * grows enough for anyone to notice otherwise.
   */
  purgeExpiredTokens().catch((err) =>
    authLog.error({ err }, "no se pudo purgar token_uso_unico tras el login"),
  );
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
 *
 * `expires_at` comes straight off `req.user`, where `authenticate` put the
 * session's *effective* expiry — the row's own value, pushed forward if this
 * request was the one that renewed it, and never later than thirty days from
 * `created_at` whatever the row says. Not the raw column: see the comment
 * there for both reasons, and for why taking it off `req.user` beats asking
 * the database again here.
 *
 * The same value also arrives on every authenticated response as
 * `SESSION_EXPIRES_HEADER`, which is what a client should prefer — this body
 * only reaches it on the 2xx of this one endpoint, while the server renews the
 * session on any authenticated request. This field stays because it is the
 * answer to the first question a page asks on load, in the same round trip as
 * the rest of it.
 *
 * It is always a date, and until this task it was not. A caller on the old
 * bearer token had no row behind it, so the field was written
 * `caller.expires_at ?? null` and this endpoint had a documented `null` answer
 * meaning "there is nothing to count down". No such caller can exist now —
 * `authenticate` lets nothing through but a live session row — so that `null`
 * was not merely unused, it was unreachable, and it went with the branch that
 * produced it. A client still handling `null` here loses nothing; one that never
 * did was already right.
 */
export const me = handler("me", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const found = await UsuarioModel.findByPk(caller.id, {
    // `email` and `email_verified_at` are here because the profile screen has
    // to show both, and the second one is the half that matters: a stored but
    // unverified address is worth exactly as much as no address at all, and a
    // screen that draws it as just another field lets somebody believe their
    // way back in is set up when it is not.
    //
    // Safe to send here and nowhere else: this endpoint answers "who am I" for
    // the caller's own account, behind `authenticate`. `USUARIO_AS_AUTHOR`
    // stays as it is — an address is not part of being named as the author of
    // something, and widening that list is how a column leaks into every
    // endpoint that includes a user.
    attributes: ["id", "id_rol", "user", "name", "lastname", "image", "email", "email_verified_at"],
  });
  // Archived between `authenticate` and here. A narrow race, and the answer is
  // the same as authenticate's: the session is over.
  if (!found) return res.status(401).json({ message: CUENTA_INACTIVA });

  const usuario = found.dataValues;
  const cuerpo = {
    usuario,
    expires_at: caller.expires_at,
    /**
     * Which of the three states this session is in, so the client can say why.
     *
     * **Without this field, the day the grace period runs out is
     * undebuggable.** The login answers 200, the browser navigates into the
     * ERP, and from then on `authenticate` refuses everything outside the
     * allowlist. A 200 followed by 403s with no distinguishable cause is
     * indistinguishable — to the person, to the front end, and to whoever
     * picks up the phone — from a server that has broken or a role whose
     * permissions were changed. And this is not a failure that might happen:
     * `estadoInicialDeSesion` guarantees every account arrives at it,
     * `MFA_GRACE_DAYS` after its own first login. A datum that makes a
     * guaranteed failure legible is the minimum that makes it supportable.
     *
     * Read off `req.user`, where `authenticate` already put it, exactly as
     * `expires_at` above is. **No extra query**, and nothing added to the
     * `attributes` list: this is the session's state, not a column of
     * `usuarios`.
     *
     * **`estado` and nothing else.** Not `mfa_grace_until`, not the factor
     * inventory. The state of your own session is something you are already
     * living — it decides what you may reach this second, so publishing it to
     * its owner reveals nothing they cannot discover by clicking. The grace
     * deadline is scheduling data the client has no use for yet, and it was
     * deliberately kept out of the login body for that reason (see
     * `ResultadoCredenciales` in `auth/credentials.ts`); the same reasoning
     * keeps it out of here.
     */
    estado: caller.estado,
  };

  /**
   * **The permission matrix is only published to a `completa` session.** The
   * specification says it in five words — "en estado no `completa`, devuelve
   * estado sin permisos" — and until now this endpoint sent the whole matrix
   * to every state.
   *
   * What that gave away is the account's map of authority: every module, every
   * action, for the caller's role. This endpoint is named in `PARCIAL`
   * (`auth/sessionState.ts`), the narrowest allowlist there is, so it is one of
   * the few addresses a session that has passed the password and **not** the
   * second factor can reach at all — and from plan 4B on, that session belongs
   * to somebody real: whoever has the password, and only the password. Such a
   * session cannot *use* a single line of the matrix, since `authenticate`
   * refuses everything outside that allowlist, which is exactly what made
   * sending it free reconnaissance rather than a feature.
   *
   * **Absent, not empty.** `{}` would be a different sentence — "this account
   * may do nothing" — and a client cannot tell that apart from an account
   * whose role really is empty. Leaving the key out says what is true: not
   * published in this state. The client already reads it that way (`permisos:
   * response.data.permisos as Permisos | undefined`, and `if (sesion.permisos)`
   * before it stores anything, in `web/src`), so nothing that works today
   * starts crashing.
   *
   * And the query goes with it: `permissionsFor` is not called at all for a
   * state that would not be shown the answer.
   */
  if (caller.estado !== "completa") return res.status(200).json(cuerpo);

  return res.status(200).json({ ...cuerpo, permisos: await permissionsFor(usuario.id_rol) });
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

  // `revokeSessionOf` and not a revoke-by-id: the owner is in scope here, so
  // there is no reason for this call to be the one place in the codebase that
  // closes a session without saying whose it is.
  await revokeSessionOf(caller.id, caller.id_sesion);
  clearSessionCookie(res);
  logAction({ id_usuario: caller.id, action: "LOGOUT", entity: "Usuario", entity_id: caller.id, detail: "Cerró la sesión de este dispositivo", metadata: { id_sesion: caller.id_sesion }, severity: 'info', ip_address: req.ip ?? null });
  return res.status(200).json({ message: "Sesión cerrada." });
});

/**
 * `POST /api/auth/logout-all` — end every session I have.
 *
 * The button for "I lost my laptop", and the one thing the JWT could never do.
 * Now it does it completely: every live row of the account is revoked, the
 * caller's own among them, because the caller's credential *is* a row. While
 * the bearer token existed this endpoint had a second answer for a caller with
 * no row — "se cerraron sus sesiones, pero este navegador seguirá dentro" — and
 * that sentence was an honest description of the hole. There is no such caller
 * left, so there is no such sentence.
 */
export const logoutAll = handler("logoutAll", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const cerradas = await revokeAllSessionsOf(caller.id);
  clearSessionCookie(res);
  // `tenia_fila` used to ride along in this metadata, recording whether the
  // caller had a session row at all. Every caller has one, so it recorded a
  // constant — and a constant in an audit trail is worse than nothing, because
  // the next person reading the bitácora takes it for a distinction that was
  // once measured.
  logAction({ id_usuario: caller.id, action: "LOGOUT_ALL", entity: "Usuario", entity_id: caller.id, detail: `Cerró todas sus sesiones (${cerradas})`, metadata: { sesiones_revocadas: cerradas }, severity: 'warning', ip_address: req.ip ?? null });
  // One sentence, and it is true without qualification for the first time.
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
 * closing the session doing the asking. Exactly one row of a non-empty list
 * carries it now: the caller's credential is a session row, so it is one of the
 * rows being listed. It used to be possible for none of them to be marked — a
 * request on the old bearer path had no row to be — and a screen written around
 * that case is written around a caller that no longer exists.
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

  const raw = req.params.id;
  // Same 404 as a session that is not yours: from the caller's side a malformed
  // id and a stranger's id are both "no such session of mine", and answering
  // differently would be one more thing to measure.
  if (typeof raw !== "string") {
    return res.status(404).json({ message: SESION_NO_ENCONTRADA });
  }
  /**
   * Lower-cased before anything else looks at it.
   *
   * Postgres normalises the `uuid` type, so `WHERE id = 'ABC…'` finds the row
   * stored as `abc…` and the revocation worked in upper case. The comparison
   * against `caller.id_sesion` further down is JavaScript's, and that one is
   * byte-for-byte: closing your *own* session with the id typed in upper case
   * answered 200, revoked the row, wrote `era_la_actual: false` in the bitácora
   * and **left the cookie in place** — so the browser went on sending a revoked
   * token and collecting 401s with nothing to explain why. Precisely the
   * failure the comment further down says it prevents.
   */
  const id = raw.toLowerCase();
  if (!ES_UUID.test(id)) {
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
