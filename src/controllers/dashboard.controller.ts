import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { PosteModel } from "../models/poste.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { MaterialModel } from "../models/material.model.js";

export async function getDashboard(req: Request, res: Response) {
  try {
    const [eventos, postes] = await Promise.all([
      EventoModel.findAll({
        attributes: ["id", "description", "state", "date", "priority", "id_poste"],
        include: [{
          model: PosteModel,
          attributes: ["id", "name", "lat", "lng"],
          include: [{ model: PropietarioModel, attributes: ["name"] }],
        }],
      }),
      PosteModel.findAll({
        attributes: ["id", "name", "lat", "lng", "date"],
        include: [
          { model: CiudadModel, as: "ciudadA", attributes: ["id", "name"] },
          { model: CiudadModel, as: "ciudadB", attributes: ["id", "name"] },
          { model: PropietarioModel, attributes: ["name"] },
          { model: MaterialModel, attributes: ["name"] },
        ],
      }),
    ]);
    res.status(200).json({ eventos, postes });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    res.status(500).json({ message: msg });
  }
}
