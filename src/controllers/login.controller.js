import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";

const secretKey = process.env.JWT_SECRET;

export async function loginUsuario(req, res) {
  const user = req.body.user;
  const pass = req.body.pass;

  try {
    const TempUsuario = await UsuarioModel.findOne({ where: { user } });
    if (!TempUsuario)
      return res.status(500).json({ message: "Usuario inexistente" });
    const confirmPass = await bcryptjs.compare(pass, TempUsuario.pass);
    if (!confirmPass)
      return res.status(500).json({ message: "contraseña incorrecta" });

    const usuario = {
      id: TempUsuario.id,
      id_rol: TempUsuario.id_rol,
      user: TempUsuario.user,
    };
    const token = jwt.sign(usuario, secretKey);
    res.status(200).json({ usuario: usuario, message: token });
  } catch (error) {
    return res.status(500).json({ usuario: {}, message: error.message });
  }
}

// Middleware para verificar el token en rutas protegidas
export async function comprobarToken(req, res) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, secretKey, (err, user) => {
    if (err) return res.sendStatus(403);
    res.status(200).json(user);
  });
}
