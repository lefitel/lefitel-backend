import { MaterialModel } from "../models/material.model.js";

export async function getMaterial(req, res) {
  try {
    const TempMaterial = await MaterialModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createMaterial(req, res) {
  try {
    const TempMaterial = await MaterialModel.create(req.body);
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateMaterial(req, res) {
  const { id } = req.params;
  try {
    const TempMaterial = await MaterialModel.findOne({
      where: { id },
    });
    TempMaterial.set(req.body);
    await TempMaterial.save();
    res.status(200).json(TempMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleMaterial(req, res) {
  const { id } = req.params;
  try {
    await MaterialModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
