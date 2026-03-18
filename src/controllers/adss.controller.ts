import { Request, Response } from "express";
import { Op } from "sequelize";
import { AdssModel } from "../models/adss.model.js";

export async function getAdss(req: Request, res: Response) {
  const archived = req.query.archived === "true";
  try {
    const TempAdss = await AdssModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !archived,
      where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    });
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createAdss(req: Request, res: Response) {
  try {
    const TempAdss = await AdssModel.create(req.body);
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateAdss(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempAdss = await AdssModel.findOne({ where: { id } });
    if (!TempAdss) return res.status(404).json({ message: "Adss no encontrado" });
    TempAdss.set(req.body);
    await TempAdss.save();
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteAdss(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await AdssModel.destroy({ where: { id } });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarAdss(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await AdssModel.restore({ where: { id } });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
