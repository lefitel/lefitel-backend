import { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { logAction } from "../utils/logAction.js";
import { permissionsFor } from "../permissions/store.js";
import { CREDENCIALES_INVALIDAS, hashRelleno } from "../config/security.js";

const secretKey = process.env.JWT_SECRET;

export async function loginUsuario(req: Request, res: Response) {
  /**
   * The username loses the spaces at its ends; the password loses nothing.
   *
   * Those are different decisions on purpose. A username is a name for a row:
   * "isaias" and "isaias " are meant to be the same person, and somebody who
   * pastes their name with a trailing space and is told "usuario inexistente"
   * has no way of seeing why. Spaces *inside* stay — `Omar Mita` is a real
   * account and trimming is not the same as stripping.
   *
   * A password is not a name, it is a secret, and every character in it counts.
   * Trimming one would silently accept a different secret than the one chosen,
   * shrink what an attacker has to guess, and lock out anybody whose password
   * legitimately starts or ends with a space.
   */
  const rawUser = req.body?.user;
  const pass = req.body?.pass;

  // Not a string is not a username. Sequelize takes an object in `where` as a
  // set of conditions, so refusing anything else here keeps a crafted body from
  // being read as a query instead of a value.
  if (typeof rawUser !== "string" || typeof pass !== "string") {
    return res.status(400).json({ message: "Usuario y contraseña son obligatorios." });
  }
  const user = rawUser.trim();
  if (user === "" || pass === "") {
    return res.status(400).json({ message: "Usuario y contraseña son obligatorios." });
  }

  try {
    const TempUsuario = await UsuarioModel.findOne({ where: { user } });

    // The account not existing and the password being wrong must be
    // indistinguishable: same message, same status, same time. Comparing
    // against the filler hash costs the same as a real comparison and is what
    // makes the third of those true.
    if (!TempUsuario) {
      await bcryptjs.compare(pass, await hashRelleno());
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }

    const data = TempUsuario.dataValues;
    const confirmPass = await bcryptjs.compare(pass, data.pass);
    if (!confirmPass) {
      logAction({ id_usuario: data.id, action: "LOGIN_FAILED", entity: "Usuario", entity_id: data.id, detail: `Login fallido para @${user}`, metadata: { user }, severity: 'warning', ip_address: req.ip ?? null });
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }

    const usuario = {
      id: data.id,
      id_rol: data.id_rol,
      user: data.user,
      name: data.name,
      lastname: data.lastname,
      image: data.image,
    };
    const token = jwt.sign(usuario, secretKey, { expiresIn: "7d" });
    // The interface draws itself from these. Sent here so the first screen after
    // logging in is already right, rather than flashing everything and then
    // hiding what this role cannot reach.
    const permisos = await permissionsFor(data.id_rol);
    logAction({ id_usuario: data.id, action: "LOGIN", entity: "Usuario", entity_id: data.id, detail: "Inició sesión", metadata: { user: data.user }, severity: 'info', ip_address: req.ip ?? null });
    res.status(200).json({ usuario: { ...usuario, token }, permisos, message: "Login exitoso" });
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
