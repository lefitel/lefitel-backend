import { CiudadModel } from "../models/ciudad.model.js";

export async function getCiudad(req, res) {
  try {
    const TempCiudad = await CiudadModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempCiudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createCiudad(req, res) {
  try {
    const TempCiudad = await CiudadModel.create(req.body);
    res.status(200).json(TempCiudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateCiudad(req, res) {
  const { id } = req.params;
  try {
    const TempCiudad = await CiudadModel.findOne({
      where: { id },
    });
    TempCiudad.set(req.body);
    await TempCiudad.save();
    res.status(200).json(TempCiudad);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleCiudad(req, res) {
  const { id } = req.params;
  try {
    await CiudadModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
