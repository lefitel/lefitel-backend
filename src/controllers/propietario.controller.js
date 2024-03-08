import { PropietarioModel } from "../models/propietario.model.js";

export async function getPropietario(req, res) {
  try {
    const TempPropietario = await PropietarioModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createPropietario(req, res) {
  try {
    const TempPropietario = await PropietarioModel.create(req.body);
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updatePropietario(req, res) {
  const { id } = req.params;
  try {
    const TempPropietario = await PropietarioModel.findOne({
      where: { id },
    });
    TempPropietario.set(req.body);
    await TempPropietario.save();
    res.status(200).json(TempPropietario);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function detelePropietario(req, res) {
  const { id } = req.params;
  try {
    await PropietarioModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
