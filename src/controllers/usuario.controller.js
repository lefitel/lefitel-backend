import { RolModel } from "../models/rol.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";

export async function getUsuario(req, res) {
  try {
    const TempUsuario = await UsuarioModel.findAll({
      order: [["id", "DESC"]],
      include: [{ model: RolModel }],
    });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function searchUsuario(req, res) {
  const { id } = req.params;
  try {
    const TempUsuario = await UsuarioModel.findOne({
      where: { id },
    });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function searchUsuario_user(req, res) {
  const { user } = req.params;
  try {
    const TempUsuario = await UsuarioModel.findOne({
      where: { user },
    });
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createUsuario(req, res) {
  try {
    req.body.pass = await bcryptjs.hash(req.body.pass, 8);

    const TempUsuario = await UsuarioModel.create(req.body);
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateUsuario(req, res) {
  const { id } = req.params;
  try {
    const TempUsuario = await UsuarioModel.findOne({
      where: { id },
    });
    TempUsuario.set(req.body);
    await TempUsuario.save();
    res.status(200).json(TempUsuario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleUsuario(req, res) {
  const { id } = req.params;
  try {
    await UsuarioModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
