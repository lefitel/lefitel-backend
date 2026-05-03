import { Request, Response } from "express";
import { AdssPosteModel } from "../models/adssPoste.model.js";

export async function getAdssPoste(req: Request, res: Response) {
  const { id_poste } = req.params;
  try {
    const TempAdssPoste = await AdssPosteModel.findAll({
      where: { id_poste },
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempAdssPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
