import type { Request, Response, NextFunction } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { findLiveSession, touchSession, slidingExpiry, cappedByCeiling } from "../auth/sessionStore.js";
import {
  puedeAlcanzar,
  puedeVerArchivosEstaticos,
  estadoEfectivo,
  MENSAJE_FACTOR_PENDIENTE,
} from "../auth/sessionState.js";
import type { EstadoSesion } from "../auth/sessionState.js";
import { readSessionCookie, setSessionCookie } from "../auth/sessionCookie.js";
import { SESSION_TOUCH_THROTTLE_MINUTES, ROLE_HEADER, SESSION_EXPIRES_HEADER } from "../config/security.js";
import { log } from "../utils/logger.js";

const authLog = log("auth");
const SESION_EXPIRADA = "Su sesión expiró. Vuelva a iniciar sesión.";
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";
const SESION_INCOMPLETA = "Termina de iniciar sesión.";
const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";

/**
 * Who the caller is. One credential: the session cookie.
 *
 * **This is where revocation became real.** Until this task there was a second
 * door — a signed JWT read off the `Authorization` header and verified here,
 * with no session row behind it. A credential with no row is a credential
 * nothing can take back: not a logout, not "cerrar todas mis sesiones", not a
 * password change, not archiving the account. It kept working until it expired,
 * up to a week later. Every other piece of session work in this arc built the
 * row that makes revocation possible; deleting that door is what makes the row
 * the only way in.
 *
 * So `Authorization` is now an ordinary header this middleware does not read.
 * A request carrying one and no cookie has no credential at all and gets 401 —
 * not because its token is bad, but because nothing looks at it.
 *
 * **If a second credential is ever added here, the rule the old one obeyed
 * still applies.** The cookie was read first and there was no falling back from
 * it: a cookie that fails is a failure, not an invitation to try the other
 * door, because otherwise anyone who could forge the other credential would
 * bypass revocation by sending a broken cookie alongside it. With one door
 * there is nothing to fall back to and the rule has nothing left to govern —
 * which is exactly why it is written down instead of left to be rediscovered.
 *
 * The whole body is one try/catch, not just the session lookup. This runs in
 * front of every protected route in the API, and Express 4 does not catch a
 * rejected promise from an `async` middleware — it never reaches the error
 * handler, it just leaves the request hanging until the client gives up. A
 * pool exhaustion or a database restart must turn into a 500 here, not into
 * the whole API going silent.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  await autenticarContraSuperficie(req, res, next, puedeAlcanzar);
}

/**
 * The same door, guarding the field photographs instead of `/api/...`.
 *
 * Everything above this line about revocation, password rotation and the
 * fourteen-day deadline applies exactly the same way — a session is a session
 * whichever door it is walking through. The one thing that has to differ is
 * which allowlist decides whether it may pass, and that is the entire reason
 * this is a second export rather than a branch inside `authenticate` keyed on
 * the path: `puedeAlcanzar` is written in the vocabulary of `/api/...` routes
 * and has no opinion, correct or otherwise, about `/1712428860328_210.jpg`.
 * Asking it anyway is what answered 403 to `onboarding` on every photograph
 * in the ERP the moment the grace period ran out — not because `onboarding`
 * was refused images on purpose, but because nothing had ever decided the
 * question, and the API's list, asked regardless, said no by default.
 *
 * `puedeVerArchivosEstaticos` (`auth/sessionState.ts`) is that explicit
 * decision, made about this mount by what it is rather than by what it is
 * not. `app.ts` is the only caller: the images mount there is the sole
 * surface outside `/api/...` that runs behind a session today.
 */
export async function authenticateArchivos(req: Request, res: Response, next: NextFunction): Promise<void> {
  await autenticarContraSuperficie(req, res, next, (estado) => puedeVerArchivosEstaticos(estado));
}

async function autenticarContraSuperficie(
  req: Request,
  res: Response,
  next: NextFunction,
  puedeAlcanzarEstaSuperficie: (estado: EstadoSesion, ruta: string) => boolean,
): Promise<void> {
  try {
    const cookieToken = readSessionCookie(req);
    if (!cookieToken) {
      // 401, not 403: unauthenticated, not forbidden. The client uses the
      // difference to decide whether to end the session, and a 403 over a single
      // resource must not throw somebody out of the application.
      res.status(401).json({ message: SESION_EXPIRADA });
      return;
    }

    await authenticateBySession(cookieToken, req, res, next, puedeAlcanzarEstaSuperficie);
  } catch (err) {
    authLog.warn({ err }, "fallo inesperado al autenticar la petición");
    if (!res.headersSent) {
      res.status(500).json({ message: ERROR_INESPERADO });
    }
  }
}

async function authenticateBySession(
  token: string,
  req: Request,
  res: Response,
  next: NextFunction,
  puedeAlcanzarEstaSuperficie: (estado: EstadoSesion, ruta: string) => boolean,
): Promise<void> {
  const sesion = await findLiveSession(token);

  if (!sesion) {
    res.status(401).json({ message: SESION_EXPIRADA });
    return;
  }

  const usuario = await currentUser(sesion.id_usuario);
  if (!usuario) {
    res.status(401).json({ message: CUENTA_INACTIVA });
    return;
  }

  /**
   * A session older than the current password does not work, whatever else is
   * true about it.
   *
   * Every path that changes a password today also revokes the sessions
   * explicitly, and this is deliberately a second, independent answer to the
   * same question — one that a future password-changing endpoint gets for free
   * without its author knowing this rule exists. Explicit revocation is a
   * promise every caller has to keep; this is a fact of the data.
   *
   * `<` and not `<=`, and this is no longer hypothetical: `updateUserPass`
   * rotates the caller's session when they change their own password, so the
   * row it hands back can carry the very timestamp it is being measured
   * against. Refusing that one would log somebody out of the session they were
   * given a millisecond earlier — the exact failure the rotation exists to
   * avoid.
   *
   * The rows that existed before this shipped are not caught by it: the
   * migration back-fills `pass_changed_at` from each account's own `createdAt`
   * rather than from `now()`, so every session alive on deploy day was opened
   * after its own stamp. See `20260826000002-add-mfa-columns.ts`.
   *
   * **A stamp that cannot be read is a refusal, not a pass**, and that is worth
   * the two extra lines. Written as a bare comparison, an unreadable stamp made
   * the right-hand side `NaN`, and `x < NaN` is `false` — so the rule went on
   * being called and quietly stopped applying, and every session older than its
   * password kept working. A mutation test proved it: deleting
   * `"pass_changed_at"` from the `attributes` below broke nothing anywhere in
   * the suite. Neither reachable state — a projection that stopped asking, a
   * schema that lost the column — is one where letting the request through is
   * the safe guess, because invalidating sessions is this check's only job.
   */
  // `== null` before the `Date`, and not folded into the `isFinite` below:
  // `new Date(null)` is **the epoch**, not an invalid date, so a NULL stamp
  // would read as "this password last changed on 1 January 1970" and let every
  // session through — the same silent pass this guard exists to refuse, wearing
  // a timestamp. `undefined` does give `NaN`; `null` is the one that lies, and
  // `== null` catches both in one comparison.
  const marca = usuario.pass_changed_at;
  const cambiadaEn = marca == null ? NaN : new Date(marca).getTime();
  // **Both** operands, not just the stamp. `NaN < x` is `false` exactly as
  // `x < NaN` is, so closing one side and leaving the other is closing half a
  // door: a session whose `created_at` will not parse walks past a rule that
  // has already decided unreadable dates are refusals. Which operand the
  // unreadable value lands on is not a reason to answer differently.
  const creadaEn =
    sesion.created_at == null ? NaN : new Date(sesion.created_at).getTime();
  if (!Number.isFinite(cambiadaEn) || !Number.isFinite(creadaEn) || creadaEn < cambiadaEn) {
    res.status(401).json({ message: SESION_EXPIRADA });
    return;
  }

  /**
   * When this request is happening.
   *
   * Moved up from the touch block below, because the state gate is now the first
   * thing that needs it. One reading rather than two, so the instant this
   * request is judged against is the same one its session is renewed to: the
   * touch throttle, the sliding expiry, the cookie and the response header all
   * take this value. Two readings would agree to the millisecond on a fast
   * request and stop agreeing under a slow query, which is the kind of
   * disagreement that only shows up in production.
   */
  const now = new Date();

  /**
   * The state actually in force, which is **not** the one in the session row.
   *
   * `estado` is written once, at login, by `estadoInicialDeSesion`. Until this
   * line, `authenticate` believed that value for the rest of the session's
   * life: nothing rewrote it, and nothing revoked a session when its account's
   * `mfa_grace_until` went by. Somebody who logged in on day 13 of their grace
   * period was still `completa` on day 15 — and since the block further down
   * keeps pushing the idle expiry back for as long as the session goes on being
   * used, that session and any cookie stolen from it kept the whole ERP right up
   * to the absolute ceiling: `SESSION_ABSOLUTE_DAYS` from the day it was
   * **opened**, which for one opened inside the grace period lands a fortnight to
   * a month past the deadline, on an account with no second factor. The only
   * thing that closed the door was the next login, and nobody has a reason to log
   * out. The state machine exists to impose a date; the date was imposed on
   * nobody who was already inside.
   *
   * **This costs no query.** `currentUser` below already reads `usuarios` on
   * every request for the role, so `mfa_grace_until` is one more column name in
   * a projection that was being fetched anyway; `sesion` goes in whole because
   * the other three fields the rule reads — `created_at`, `mfa_satisfied_at`,
   * `mfa_source` — are already in `findLiveSession`'s projection too. Nothing
   * here counts factors: see `estadoEfectivo` for what it would have cost every
   * request in the API to ask the account-level question instead of the
   * session-level one.
   *
   * **And the rule is narrower than "the deadline passed", on purpose.** That
   * column is never cleared once stamped, so narrowing on it alone locks out
   * for ever anybody who registers a factor after their own deadline — a
   * permanent lockout with no way out from inside the API, armed here and fired
   * by plan 4B. `estadoEfectivo` carries the three clauses that scope this to
   * the sessions the deadline is actually about; read them there before
   * changing anything here.
   *
   * **And nothing is written back.** The row keeps what the login decided; this
   * is recomputed from it on each request and discarded. Storing it would make
   * it a second photograph, which is the defect being fixed.
   */
  const estado = estadoEfectivo(sesion, usuario.mfa_grace_until, now);

  /**
   * What this session may reach, on top of whether it exists.
   *
   * Until this block, `authenticate` answered one question — is this cookie a
   * live session — and a row written the instant a password was accepted
   * looked exactly like one that had proved a factor. That is what made the
   * second factor decorative: the whole ERP sat behind "the cookie exists".
   *
   * The two answers are deliberately different, and the difference is what the
   * frontend does with them:
   *
   * - `parcial` gets **401**. The login is unfinished; ending the session and
   *   going back to the start is the correct move.
   * - `onboarding` gets **403**. This person *is* logged in, and their setup
   *   screen is inside the application. A 401 here would throw them out to a
   *   login they have already passed, and they would pass it again, and land
   *   in the same place: a loop with no way out.
   *
   * That branching is about how to phrase a refusal and does not change with
   * the caller — `parcial` means "unfinished login" on every surface this
   * middleware guards. **Which allowlist decides whether there is a refusal
   * at all is what `puedeAlcanzarEstaSuperficie` carries in**: `authenticate`
   * passes `puedeAlcanzar`, written for `/api/...`; `authenticateArchivos`
   * passes `puedeVerArchivosEstaticos`, written for the images mount. Neither
   * table has an opinion about the other's routes, which is the point — see
   * `authenticateArchivos`'s own comment for why asking the wrong one was the
   * defect.
   *
   * `originalUrl` and not `req.path`: this middleware runs inside routers, so
   * `req.path` is relative to the mount point — "/1", not "/api/usuario/1".
   *
   * Placed here, after the account is resolved and before any response header
   * is written: a refused request must not carry `ROLE_HEADER` or
   * `SESSION_EXPIRES_HEADER`, which are facts about an authenticated caller
   * this one has not become.
   */
  const ruta = req.originalUrl;
  if (!puedeAlcanzarEstaSuperficie(estado, ruta)) {
    if (estado === "parcial") {
      res.status(401).json({ message: SESION_INCOMPLETA });
      return;
    }
    res.status(403).json({ message: MENSAJE_FACTOR_PENDIENTE });
    return;
  }

  // From `usuario`, i.e. from `currentUser`'s database read, and not from
  // anything the credential carries — see `ROLE_HEADER`'s comment for why
  // that is the entire point. Set on every authenticated response rather than
  // only when the role actually changed: the frontend has nothing to compare
  // it against until it has seen at least one, and comparing is its job, not
  // this middleware's.
  res.setHeader(ROLE_HEADER, String(usuario.id_rol));

  // `last_used_at` is throttled. Writing it on every request turns every read
  // into a write, and one report export makes around two thousand sequential
  // requests: that would be two thousand UPDATEs and two thousand dead tuples
  // on a single row.
  const staleAfterMs = SESSION_TOUCH_THROTTLE_MINUTES * 60_000;
  // `now` is the one read at the top of this function, before the state gate —
  // not a second reading of the clock. The instant this request is judged
  // against and the instant its session is renewed to have to be the same one.
  const createdAt = new Date(sesion.created_at);
  const slides = now.getTime() - new Date(sesion.last_used_at).getTime() > staleAfterMs;

  /**
   * When this session actually stops working — the one value the cookie, the
   * response header and `req.user` all carry, computed once here.
   *
   * Two branches because the row is only rewritten when the throttle lets it
   * be, and the answer has to describe the row as it will be *after* this
   * request, not as `findLiveSession` found it:
   *
   * - Sliding: this request is the touch, so the row is about to say
   *   `slidingExpiry(createdAt, now)` and so does everything below.
   *   Reporting `sesion.expires_at` here instead is what made somebody who
   *   came back with ten minutes left on the row learn a ten-minute window
   *   while the server had just given them another seven days — their
   *   browser then warned them and logged them out of a perfectly live
   *   session, taking whatever form was open with it.
   * - Not sliding: the row keeps the `expires_at` it already had, but capped,
   *   because that column was written without a ceiling until now and rows
   *   from before this deploy claim up to a week more than `findLiveSession`
   *   will honour. `cappedByCeiling` is the same rule the query enforces.
   */
  const expiresAt = slides
    ? slidingExpiry(createdAt, now)
    : cappedByCeiling(createdAt, new Date(sesion.expires_at));

  /**
   * Every authenticated response says when the session dies, not only the
   * ones a client can read a body from.
   *
   * This is the point of putting it in a header at all: the server slides a
   * session on *any* authenticated request, so a client that only learns the
   * new deadline from `GET /auth/me` — or only from responses that answered
   * 2xx — spends the rest of the day counting down to an instant that has
   * already moved. A 422 from a failed validation renews the session just as
   * much as a successful read does, and this runs before any controller, so
   * that answer carries the new deadline too.
   *
   * See `SESSION_EXPIRES_HEADER` for the format and for why its absence has
   * to mean "no news", never "expired". Nothing in this file can now answer
   * 2xx without setting it — every authenticated request comes through the
   * lines above — so the only way a client sees it missing is a proxy that
   * dropped a header it did not recognise, and treating that as "expired"
   * would log somebody out of a live session for a header they never got.
   */
  res.setHeader(SESSION_EXPIRES_HEADER, expiresAt.toISOString());

  if (slides) {
    // `createdAt` goes to the store as well, so the row is written with the
    // ceiling applied rather than a bare seven days — see `touchSession`.
    touchSession(sesion.id, now, createdAt).catch((err) =>
      authLog.warn({ err }, "no se pudo actualizar el último uso de la sesión"),
    );

    // The cookie's own `Expires` is fixed once, at login (`issueSession.ts`),
    // and nothing short of a fresh `Set-Cookie` moves it. Without this, the
    // "seven days of inactivity" this design promises is actually "seven
    // days since login" — a hard ceiling nobody chose. Reissued here, on the
    // same throttle as the database write above, so this is one `Set-Cookie`
    // header per throttle window rather than one per request.
    setSessionCookie(res, token, expiresAt);
  }

  // `expires_at` rides along on `req.user` rather than being looked up again
  // inside `/auth/me`, and doing it this way costs nothing extra: the value is
  // the one already computed above, so handing it to `req.user` is a field
  // copy, not a query. Querying again from the controller would trade that
  // free value for a second `SesionModel.findOne` on every call — cheap for an
  // endpoint that only runs once per page load, but still a database round
  // trip this data does not need when the value is already sitting in memory.
  //
  // All fields are **required** on `req.user` (`app.ts`), and this line is the
  // only thing that fills them in. `id_sesion` and `expires_at` were optional
  // because the old bearer path reached `next()` without a session row, so
  // half of `req.user` was absent and six places in `auth.controller.ts` had
  // to ask whether it was there. That path is gone: an authenticated request
  // has a row by construction, and the type says so, so those questions
  // cannot be asked again. `estado` and `mfa_satisfied_at` follow the same
  // rule for the same reason — the step-up gate a later task adds reads both
  // and must not have to ask whether they are there either.
  req.user = {
    id: usuario.id,
    id_rol: usuario.id_rol,
    id_sesion: sesion.id,
    expires_at: expiresAt,
    // The recomputed one, not `sesion.estado`, and two things read it.
    //
    // **`GET /api/auth/me` reads it for two decisions**, and they are the
    // whole of what this rule changes on a request it does *not* refuse.
    // `/api/auth/me` is in `PARCIAL`, so every state reaches it.
    //
    // It *publishes* the value: from here on that endpoint answers
    // `onboarding` mid-session instead of the `completa` the row still holds.
    // That is the improvement, not a side effect — the endpoint's own comment
    // says this field exists because "the day the grace period runs out is
    // undebuggable" without it, and until now it went on saying `completa`
    // while the ERP answered 403, which is exactly the confusion it was added
    // to prevent.
    //
    // And it *withholds the permission matrix* on anything but `completa`,
    // which is the larger of the two and arrived later: the answer's very
    // shape now depends on this line rather than on `sesion.estado`. A
    // session the row still calls `completa`, and this rule has decided is
    // not, stops being handed the account's map of authority — pinned by
    // "stops handing that session the permission matrix" in
    // `app.auth.test.ts`, which goes through the assembled app precisely so
    // that it is *this* value being read and not the stored one.
    //
    // **`requireStepUp` reads it too**, and there the stored value would leave
    // the gate believing a session the check above has already decided is past
    // its deadline. That used to reach nothing: every route the gate guarded
    // lived under `/api/usuario`, `/api/rol` and `/api/permiso`, none of which
    // the `onboarding` allowlist opens, so `puedeAlcanzar` refused them before
    // this line ran. It is no longer so. `DELETE /api/auth/sessions/:id` now
    // carries the gate, and it sits behind `/api/auth/sessions`, which
    // `ONBOARDING_EXTRA` **does** open — so this field, and not the row, is
    // what stands between a session past its deadline and closing every other
    // session of the account it was stolen from.
    estado,
    mfa_satisfied_at: sesion.mfa_satisfied_at,
  };
  next();
}

/**
 * The user this request belongs to, as they are right now.
 *
 * The role comes from the database and not from the credential: under the old
 * token, somebody moved to another role kept the old one — and the old buttons
 * with it — for up to a week. `findByPk` is paranoid, so an archived account
 * returns nothing and the session ends here.
 *
 * `pass_changed_at` and `mfa_grace_until` ride along on the same read for the
 * same reason and at the same price: the row is being fetched anyway, so each
 * column costs one more name in `attributes` rather than a second query per
 * request. That price is what makes the state recomputation above free —
 * `authenticate` still makes exactly two reads per request, the session row and
 * this one, and the fourteen-day deadline arrives on the second of them.
 */
async function currentUser(id: number): Promise<{
  id: number;
  id_rol: number;
  pass_changed_at: Date | undefined;
  mfa_grace_until: Date | null | undefined;
} | null> {
  const found = await UsuarioModel.findByPk(id, {
    attributes: ["id", "id_rol", "pass_changed_at", "mfa_grace_until"],
  });
  if (!found) return null;
  return {
    id: found.dataValues.id as number,
    id_rol: found.dataValues.id_rol as number,
    // `Date | undefined` and **not** `as Date`. The column is `NOT NULL`, so
    // the assertion looked free — but the caller's whole job is doubting that
    // this value arrived, and a type promising "always a Date" is the compiler
    // agreeing with the assumption the guard exists to check.
    //
    // It does not *enforce* anything yet, and saying so matters more than the
    // change: this project compiles with `"strict": false`, so
    // `strictNullChecks` is off and `Date | undefined` is assignable wherever
    // `Date` is. Deleting the `== null` check below is measurably **not** a
    // type error today — what catches it is the "refuses when the stamp cannot
    // be read at all" test. The declaration is honest now and starts doing the
    // work the day the project's type gate goes strict.
    pass_changed_at: found.dataValues.pass_changed_at,
    // `null` as well as `undefined`, and the two mean different things even
    // though `estadoEfectivo` answers both the same way. NULL is the column's
    // real, common value — every account has it until its first login after the
    // deploy, and again after the documented reprieve. `undefined` is what a
    // projection that stopped naming the column would produce, which is not a
    // state the database can be in; the type says so rather than flattening
    // both into one.
    mfa_grace_until: found.dataValues.mfa_grace_until,
  };
}
