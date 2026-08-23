import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { UsuarioModel } from "../models/usuario.model.js";
import { findLiveSession, touchSession, slidingExpiry } from "../auth/sessionStore.js";
import { readSessionCookie, setSessionCookie } from "../auth/sessionCookie.js";
import { SESSION_TOUCH_THROTTLE_MINUTES, ROLE_HEADER } from "../config/security.js";
import { log } from "../utils/logger.js";

const authLog = log("auth");
const SESION_EXPIRADA = "Su sesión expiró. Vuelva a iniciar sesión.";
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";
const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";

/**
 * Who the caller is, from either credential.
 *
 * Two paths on purpose, and only for as long as the transition lasts. The
 * backend deploys on one platform and the frontend on another, so they cannot
 * change at the same instant: without a period where both credentials work,
 * there is a window in which one side is new and the other old and nobody can
 * get in at all.
 *
 * The cookie is checked first and **there is no falling back from it**. A
 * cookie that fails is a failure, not an invitation to try the other door —
 * otherwise anyone who could forge a bearer token would bypass revocation by
 * sending a broken cookie alongside it.
 *
 * The bearer path logs every use, so the day it is retired the decision rests
 * on a number instead of a guess.
 *
 * The whole body is one try/catch, not just the session lookup. This runs in
 * front of every protected route in the API, and Express 4 does not catch a
 * rejected promise from an `async` middleware — it never reaches the error
 * handler, it just leaves the request hanging until the client gives up. A
 * pool exhaustion or a database restart must turn into a 500 here, not into
 * the whole API going silent.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cookieToken = readSessionCookie(req);
    if (cookieToken) {
      await authenticateBySession(cookieToken, req, res, next);
      return;
    }

    const authHeader = req.headers["authorization"];
    const bearer = authHeader && authHeader.split(" ")[1];
    if (bearer) {
      await authenticateByLegacyToken(bearer, req, res, next);
      return;
    }

    // 401, not 403: unauthenticated, not forbidden. The client uses the
    // difference to decide whether to end the session, and a 403 over a single
    // resource must not throw somebody out of the application.
    res.status(401).json({ message: SESION_EXPIRADA });
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
  const now = new Date();
  if (now.getTime() - new Date(sesion.last_used_at).getTime() > staleAfterMs) {
    touchSession(sesion.id, now).catch((err) =>
      authLog.warn({ err }, "no se pudo actualizar el último uso de la sesión"),
    );

    // The cookie's own `Expires` is fixed once, at login (`issueSession.ts`),
    // and nothing short of a fresh `Set-Cookie` moves it. Without this, the
    // "seven days of inactivity" this design promises is actually "seven
    // days since login" — a hard ceiling nobody chose. Reissued here, on the
    // same throttle as the database write above, so this is one `Set-Cookie`
    // header per throttle window rather than one per request. Capped at the
    // absolute ceiling measured from this session's own `created_at`, so a
    // session touched regularly still cannot slide the cookie past the day
    // the row itself stops being honoured.
    setSessionCookie(res, token, slidingExpiry(new Date(sesion.created_at), now));
  }

  // `expires_at` rides along on `req.user` rather than being looked up again
  // inside `/auth/me`, and doing it this way costs nothing extra: this
  // function already has `sesion.expires_at` in hand from the
  // `findLiveSession` call above, so handing it to `req.user` is a field copy,
  // not a query. Querying again from the controller would trade that free
  // value for a second `SesionModel.findOne` on every call — cheap for an
  // endpoint that only runs once per page load, but still a database round
  // trip this data does not need when the value is already sitting in memory.
  // Optional for the same reason `id_sesion` already is: a request
  // authenticated by the old bearer token has no row, and therefore nothing
  // to report an expiry from.
  req.user = { id: usuario.id, id_rol: usuario.id_rol, id_sesion: sesion.id, expires_at: sesion.expires_at };
  next();
}

/**
 * The old path: a signed token with no row behind it.
 *
 * Kept only until the frontend stops sending it, and logged every time so that
 * retiring it is a measurement rather than a bet. Note what it cannot do: a
 * token on this path cannot be revoked, which is the entire defect this plan
 * exists to fix. Every request through here is the old hole, still open.
 *
 * `jwt.verify` takes a callback rather than returning a promise, so the
 * lookup inside it is wrapped in its own promise: without that, a rejection
 * from `currentUser` would happen inside a plain callback, outside anything
 * `authenticate`'s try/catch can see, and the request would hang exactly the
 * way the async-middleware defect did.
 */
function authenticateByLegacyToken(
  token: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET as string, (err, payload) => {
      if (err) {
        res.status(401).json({ message: SESION_EXPIRADA });
        resolve();
        return;
      }
      const claims = payload as { id: number };
      currentUser(claims.id)
        .then((usuario) => {
          if (!usuario) {
            res.status(401).json({ message: CUENTA_INACTIVA });
            resolve();
            return;
          }
          authLog.info({ id_usuario: usuario.id, ruta: req.originalUrl }, "petición autenticada con el token antiguo");
          // Same header, same source — `usuario.id_rol` off `currentUser`'s
          // database read, never `claims.id_rol` off the token. Skipping this
          // on the old path is the failure the task exists to avoid: the
          // warning would only work for whichever half of the transition
          // happened to be on the cookie already.
          res.setHeader(ROLE_HEADER, String(usuario.id_rol));
          req.user = { id: usuario.id, id_rol: usuario.id_rol };
          next();
          resolve();
        })
        .catch(reject);
    });
  });
}

/**
 * The user this request belongs to, as they are right now.
 *
 * The role comes from the database and not from the credential: under the old
 * token, somebody moved to another role kept the old one — and the old buttons
 * with it — for up to a week. `findByPk` is paranoid, so an archived account
 * returns nothing and the session ends here.
 */
async function currentUser(id: number): Promise<{ id: number; id_rol: number } | null> {
  const found = await UsuarioModel.findByPk(id, { attributes: ["id", "id_rol"] });
  if (!found) return null;
  return { id: found.dataValues.id as number, id_rol: found.dataValues.id_rol as number };
}
