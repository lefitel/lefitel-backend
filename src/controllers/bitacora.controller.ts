import { Request, Response } from "express";
import { Op, WhereOptions } from "sequelize";
import { BitacoraModel } from "../models/bitacora.model.js";
import { UsuarioModel } from "../models/usuario.model.js";

export async function getAllBitacora(req: Request, res: Response) {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { id_usuario, action, entity, from, to } = req.query;

  const where: WhereOptions = {};
  if (id_usuario) where["id_usuario"] = Number(id_usuario);
  if (action) where["action"] = action;
  if (entity) where["entity"] = entity;
  if (from || to) {
    where["createdAt"] = {
      ...(from ? { [Op.gte]: new Date(from as string) } : {}),
      ...(to ? { [Op.lte]: new Date(to as string) } : {}),
    };
  }

  try {
    const data = await BitacoraModel.findAll({
      where,
      order: [["id", "DESC"]],
      limit,
      include: [{ model: UsuarioModel, attributes: ["id", "name", "lastname", "user"] }],
    });
    res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getBitacora(req: Request, res: Response) {
  const { id_usuario } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  try {
    const data = await BitacoraModel.findAll({
      where: { id_usuario },
      order: [["id", "DESC"]],
      limit,
    });
    res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
