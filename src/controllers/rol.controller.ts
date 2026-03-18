import { Request, Response } from "express";
import { RolModel } from "../models/rol.model.js";

export async function getRol(req: Request, res: Response) {
  try {
    const TempRol = await RolModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createRol(req: Request, res: Response) {
  try {
    const TempRol = await RolModel.create(req.body);
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateRol(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempRol = await RolModel.findOne({ where: { id } });
    if (!TempRol) return res.status(404).json({ message: "Rol no encontrado" });
    TempRol.set(req.body);
    await TempRol.save();
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deleteRol(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await RolModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
