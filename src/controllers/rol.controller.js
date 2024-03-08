import { RolModel } from "../models/rol.model.js";

export async function getRol(req, res) {
  try {
    const TempRol = await RolModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createRol(req, res) {
  try {
    const TempRol = await RolModel.create(req.body);
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateRol(req, res) {
  const { id } = req.params;
  try {
    const TempRol = await RolModel.findOne({
      where: { id },
    });
    TempRol.set(req.body);
    await TempRol.save();
    res.status(200).json(TempRol);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleRol(req, res) {
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
