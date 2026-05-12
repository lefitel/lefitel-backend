import { Request, Response } from "express";
import { Op, WhereOptions } from "sequelize";
import { BitacoraModel } from "../models/bitacora.model.js";
import { UsuarioModel } from "../models/usuario.model.js";

export async function getAllBitacora(req: Request, res: Response) {
  const page   = Math.max(Number(req.query.page)  || 1,   1);
  const limit  = Math.min(Number(req.query.limit) || 50, 100);
  const offset = (page - 1) * limit;
  const { id_usuario, action, entity, entity_id, from, to, severity, sortBy, sortOrder } = req.query;

  const where: WhereOptions = {};
  if (id_usuario) where["id_usuario"] = Number(id_usuario);
  if (action)     where["action"]     = { [Op.like]: `${action}%` };
  if (entity)     where["entity"]     = entity;
  if (entity_id)  where["entity_id"]  = Number(entity_id);
  if (severity)   where["severity"]   = severity;
  if (from || to) {
    where["createdAt"] = {
      ...(from ? { [Op.gte]: new Date(from as string) } : {}),
      ...(to   ? { [Op.lte]: new Date(to   as string) } : {}),
    };
  }

  try {
    const SORTABLE = new Set(["id", "action", "entity", "severity", "createdAt"]);
    const sortByCols = Array.isArray(sortBy) ? sortBy as string[] : sortBy ? [sortBy as string] : [];
    const sortOrderVals = Array.isArray(sortOrder) ? sortOrder as string[] : sortOrder ? [sortOrder as string] : [];
    const orderEntries = sortByCols.map((col, i) => {
      const dir = sortOrderVals[i] === "asc" ? "ASC" : "DESC";
      return SORTABLE.has(col) ? [col, dir] : null;
    }).filter(Boolean);

    const { count, rows } = await BitacoraModel.findAndCountAll({
      where,
      order: orderEntries.length ? orderEntries as [[string, string]] : [["id", "DESC"]],
      limit,
      offset,
      include: [{ model: UsuarioModel, attributes: ["id", "name", "lastname", "user"] }],
    });
    res.status(200).json({ data: rows, total: count });
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
