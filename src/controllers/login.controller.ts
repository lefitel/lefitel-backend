// What is left of the old front door: the JWT verifier behind `GET
// /api/login`, and nothing else.
//
// The login itself used to live here — its own copy of the endpoint, answering
// with a signed seven-day JWT in the body beside the session cookie. It is
// gone, and with it the only `jwt.sign` in the repository: `POST /api/login`
// now runs `auth.controller.ts`'s `login`, the same function `POST
// /api/auth/login` runs, so there is nothing here to drift from it. The `jwt`
// import that survives is `verify`, not `sign`, and it belongs to the function
// below.

import { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import jwt from "jsonwebtoken";
import { permissionsFor } from "../permissions/store.js";
import { log } from "../utils/logger.js";

const secretKey = process.env.JWT_SECRET;
const loginLog = log("auth");

/**
 * What an unexpected failure in this file answers with — the same wording
 * `authenticate.ts` and `auth.controller.ts`'s `handler()` already use for the
 * same situation, kept as its own local constant here rather than imported,
 * exactly as those two do.
 *
 * This used to answer with `error.message` instead: whatever the database
 * driver said, verbatim, in the body of a response to a caller who has not
 * authenticated. A Postgres error names its own tables and columns, which is
 * half of what somebody probing this endpoint for an injection needs to know,
 * handed over for free by a request that only had to be malformed or badly
 * timed. The real error still goes to the log — this is only what crosses the
 * wire.
 */
const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";

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
