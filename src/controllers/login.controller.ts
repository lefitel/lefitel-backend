import { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import jwt from "jsonwebtoken";
import { permissionsFor } from "../permissions/store.js";
import { verifyCredentials } from "../auth/credentials.js";
import { issueSession } from "../auth/issueSession.js";
import { log } from "../utils/logger.js";

const secretKey = process.env.JWT_SECRET;
const loginLog = log("auth");

/**
 * `POST /api/login` — the door the current frontend still uses.
 *
 * What used to be two hundred lines of credential checking is now one call to
 * `verifyCredentials`, which is the same function `POST /api/auth/login` calls.
 * The uniform message, the filler hash that levels the timings, the per-account
 * lockout and the cost re-hash all live there now, once. Nothing about the
 * answer this endpoint gives has changed: same statuses, same messages, same
 * body — plus a cookie.
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
     * Best effort, and that is a decision rather than laziness.
     *
     * The credential this endpoint promises is the JWT below, and it works
     * whether or not a session row was written. So if opening one fails — the
     * pool exhausted, the table locked — refusing the login would take the
     * whole company out over a feature they are not using yet, to gain
     * nothing: the request that follows would authenticate on the bearer path
     * exactly as it did last week.
     *
     * `POST /api/auth/login` treats the same failure as fatal, because there
     * the session *is* the credential and answering 200 without one would hand
     * the browser a login it will be refused with everywhere.
     */
    try {
      await issueSession(req, res, check.usuario.id);
    } catch (err) {
      loginLog.warn(
        { err, id_usuario: check.usuario.id },
        "no se pudo abrir la sesión de cookie en el login antiguo; se entra solo con el token",
      );
    }

    const token = jwt.sign(check.usuario, secretKey, { expiresIn: "7d" });
    // The interface draws itself from these. Sent here so the first screen after
    // logging in is already right, rather than flashing everything and then
    // hiding what this role cannot reach.
    const permisos = await permissionsFor(check.usuario.id_rol);
    res.status(200).json({ usuario: { ...check.usuario, token }, permisos, message: "Login exitoso" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    return res.status(500).json({ usuario: {}, message: msg });
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Error desconocido";
      return res.status(500).json({ message: msg });
    }
  });
}
