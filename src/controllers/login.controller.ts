import { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import jwt from "jsonwebtoken";
import { permissionsFor } from "../permissions/store.js";
import { logLogin, verifyCredentials } from "../auth/credentials.js";
import { issueSession } from "../auth/issueSession.js";
import { log } from "../utils/logger.js";

const secretKey = process.env.JWT_SECRET;
const loginLog = log("auth");

/**
 * What somebody is told when their password was right and the server still
 * could not let them in.
 *
 * Not beside `CREDENCIALES_INVALIDAS` and `CREDENCIALES_INCOMPLETAS` in
 * `config/security.ts`, and the line is worth drawing: those two are a pair
 * about the *credential*, kept together precisely so nobody rewords one
 * without seeing the other and leaks which usernames exist. This says nothing
 * about the account — it is about this server, right now — so it belongs to the
 * endpoint, not to that pair.
 *
 * "In a few minutes" is the whole point of the wording: the two ways to get
 * here are an exhausted connection pool and a locked `sesiones` table, and both
 * pass. Retyping the password will not help and the person needs to be told
 * that rather than left to conclude they have forgotten it.
 */
const SESION_NO_DISPONIBLE =
  "No se pudo iniciar la sesión en este momento. Inténtelo de nuevo en unos minutos.";

/**
 * What every other unexpected failure in this file answers with — the same
 * wording `authenticate.ts` and `auth.controller.ts`'s `handler()` already
 * use for the same situation, kept as its own local constant here rather
 * than imported, exactly as those two do.
 *
 * Both handlers below used to answer with `error.message` instead: whatever
 * the database driver said, verbatim, in the body of a response to a caller
 * who has not authenticated. A Postgres error names its own tables and
 * columns, which is half of what somebody probing this endpoint for an
 * injection needs to know, handed over for free by a request that only had
 * to be malformed or badly timed. The real error still goes to the log —
 * this is only what crosses the wire.
 */
const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";

/**
 * `POST /api/login` — the door the current frontend still uses.
 *
 * What used to be two hundred lines of credential checking is now one call to
 * `verifyCredentials`, which is the same function `POST /api/auth/login` calls.
 * The uniform message, the filler hash that levels the timings, the per-account
 * lockout and the cost re-hash all live there now, once. The answer kept its
 * shape through that move — same statuses, same messages, same body, plus a
 * cookie — and has since gained exactly one status it did not have: the 503 of
 * a session that could not be opened, whose reasoning is at the call site
 * below and is the reason this endpoint is no longer a strict superset of the
 * one the frontend was written against.
 *
 * The cookie is the whole point of the change. Every person who logs in through
 * the frontend as it is today gets a real session row opened for them without
 * noticing, so the day the new frontend ships they are already migrated, and
 * the count of requests still arriving on the bearer path — which
 * `authenticate` logs one by one — is what says when the old token can be
 * retired instead of anybody having to guess.
 */
export async function loginUsuario(req: Request, res: Response) {
  try {
    const check = await verifyCredentials({
      user: (req.body as { user?: unknown } | undefined)?.user,
      pass: (req.body as { pass?: unknown } | undefined)?.pass,
      ip: req.ip ?? null,
    });
    if (!check.ok) {
      return res.status(400).json({ message: check.message });
    }

    /**
     * A session this endpoint cannot open is a login it cannot grant. Fatal,
     * like `POST /api/auth/login` — and it did not use to be.
     *
     * **The old decision was right when it was made.** It let this failure
     * through with a `warn` and answered 200 with the JWT below, on the
     * argument that the credential this endpoint promises is that token, so
     * the session row was a bonus: refusing a correct password over a failed
     * INSERT would have taken the whole company out over a feature nobody was
     * using yet, and the very next request would have authenticated on the
     * bearer path exactly as it had the week before. Every clause of that was
     * true. What made it false is not an error inside it but a change
     * underneath it — the frontend now discards this token the moment it
     * arrives (`web/src/api/Login.api.ts`) and sends no `Authorization` header
     * anywhere in the application, so the fallback the whole argument rests on
     * no longer exists. The premise expired. The reasoning never did, and this
     * is the shape a comment leaves behind when it does: correct, cited, and
     * quietly describing a world that has moved.
     *
     * **What a 200 without a cookie buys now.** `verifyCredentials` says yes,
     * so the browser is told "Bienvenido" and navigated into the ERP; the
     * first request for data carries no credential at all, comes back 401, and
     * the response interceptor puts the person back on the login form. A flash
     * of the application between a welcome and an empty form, with nothing on
     * screen to explain it, and identically on every retry, because what is
     * broken is the database and not anything they typed.
     *
     * **503 rather than 500** because that is what this is: not a bug in this
     * request but a dependency that is down, and the difference is the
     * difference between "try again shortly" and "something is wrong with the
     * software" for whoever reads the log. The sentence reaches the screen —
     * `Login.api.ts` reads `data.message` off any non-2xx answer and hands it
     * to the form — which is the entire gain over the old 200.
     *
     * **What this cannot do is lock anybody out**, which is what the old
     * comment was right to worry about. The per-account lockout counter only
     * moves inside `verifyCredentials` on a wrong password, so a database
     * outage never touches it. The rate-limit buckets in `loginLimiters.ts`
     * are a smaller matter and a real change: they count non-2xx answers, so
     * ten of these from one machine against one account inside a quarter of an
     * hour will start answering 429 instead. Waiting is the correct advice in
     * both cases, and nothing persists past the window.
     */
    try {
      await issueSession(req, res, check.usuario.id);
    } catch (err) {
      loginLog.error(
        { err, id_usuario: check.usuario.id },
        "no se pudo abrir la sesión de cookie: se rechaza el login, porque el token del cuerpo ya no autentica nada",
      );
      return res.status(503).json({ message: SESION_NO_DISPONIBLE });
    }

    const token = jwt.sign(check.usuario, secretKey, { expiresIn: "7d" });
    // The interface draws itself from these. Sent here so the first screen after
    // logging in is already right, rather than flashing everything and then
    // hiding what this role cannot reach.
    const permisos = await permissionsFor(check.usuario.id_rol);
    // After the work, not inside `verifyCredentials`. It used to be written the
    // moment the password checked out, which meant a request that then answered
    // 500 still left "Inició sesión" in the bitácora.
    logLogin(check.usuario, req.ip ?? null);
    res.status(200).json({ usuario: { ...check.usuario, token }, permisos, message: "Login exitoso" });
  } catch (err) {
    loginLog.error({ err }, "fallo inesperado en POST /api/login, antes de que hubiera credencial");
    return res.status(500).json({ usuario: {}, message: ERROR_INESPERADO });
  }
}

// Endpoint para verificar el token
/**
 * Who the bearer of this token is, right now.
 *
 * It used to answer with the token's own payload, which is a photograph taken
 * the day the person logged in. Tokens last a week: someone moved from
 * Coordinador to Cliente kept a browser that believed it was still a
 * Coordinador for the rest of it — and since the interface decided what to draw
 * from that belief, they kept seeing buttons they were no longer meant to have.
 *
 * So the role and the permissions come from the database, not from the token.
 */
export function comprobarToken(req: Request, res: Response) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, secretKey, async (err, decoded) => {
    if (err) return res.sendStatus(403);
    try {
      const claims = decoded as { id?: number };
      const stored = await UsuarioModel.findOne({
        where: { id: claims?.id },
        attributes: { exclude: ["pass"] },
      });
      // Archived or deleted since the token was issued: paranoid findOne returns
      // nothing, and the session ends rather than continuing on old claims.
      if (!stored) return res.sendStatus(403);

      const usuario = stored.dataValues;
      res.status(200).json({
        id: usuario.id,
        id_rol: usuario.id_rol,
        user: usuario.user,
        name: usuario.name,
        lastname: usuario.lastname,
        image: usuario.image,
        permisos: await permissionsFor(usuario.id_rol),
      });
    } catch (err) {
      loginLog.error({ err }, "fallo inesperado en GET /api/login (comprobarToken)");
      return res.status(500).json({ message: ERROR_INESPERADO });
    }
  });
}
