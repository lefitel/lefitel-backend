import { AdssPosteModel } from "../models/adssPoste.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";

export async function getPoste(req, res) {
  try {
    const TempPoste = await PosteModel.findAll({
      order: [["id", "DESC"]],
      include: [
        { model: MaterialModel },
        { model: PropietarioModel },
        { model: CiudadModel, as: "ciudadA" },
        { model: CiudadModel, as: "ciudadB" },
      ],
    });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createPoste(req, res) {
  try {
    const TempPoste = await PosteModel.create(req.body);
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function searchPoste(req, res) {
  const { id } = req.params;
  try {
    const TempPoste = await PosteModel.findOne({
      where: { id },
    });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updatePoste(req, res) {
  const { id } = req.params;
  try {
    const TempPoste = await PosteModel.findOne({
      where: { id },
    });
    TempPoste.set(req.body);
    await TempPoste.save();
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function detelePoste(req, res) {
  const { id } = req.params;
  try {
    await PosteModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
