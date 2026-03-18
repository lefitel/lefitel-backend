import { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { logAction } from "../utils/logAction.js";

const secretKey = process.env.JWT_SECRET;

export async function loginUsuario(req: Request, res: Response) {
  const user = req.body.user;
  const pass = req.body.pass;

  try {
    const TempUsuario = await UsuarioModel.findOne({ where: { user } });
    if (!TempUsuario)
      return res.status(400).json({ message: "Usuario inexistente" });
    const data = TempUsuario.dataValues;
    const confirmPass = await bcryptjs.compare(pass, data.pass);
    if (!confirmPass)
      return res.status(400).json({ message: "Contraseña incorrecta" });

    const usuario = {
      id: data.id,
      id_rol: data.id_rol,
      user: data.user,
      name: data.name,
      lastname: data.lastname,
      image: data.image,
    };
    const token = jwt.sign(usuario, secretKey, { expiresIn: "7d" });
    logAction({ id_usuario: data.id, action: "LOGIN", entity: "Usuario", entity_id: data.id, detail: "Inició sesión" });
    res.status(200).json({ usuario: { ...usuario, token }, message: "Login exitoso" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    return res.status(500).json({ usuario: {}, message: msg });
  }
}

// Endpoint para verificar el token
export function comprobarToken(req: Request, res: Response) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, secretKey, (err, user) => {
    if (err) return res.sendStatus(403);
    res.status(200).json(user);
  });
}
