import { BitacoraModel } from "../models/bitacora.model.js";

export async function getBitacora(req, res) {
  const { id_usuario } = req.params;

  try {
    const TempBitacora = await BitacoraModel.findAll({
      where: { id_usuario },
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempBitacora);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createBitacora(req, res) {
  try {
    const TempBitacora = await BitacoraModel.create(req.body);
    res.status(200).json(TempBitacora);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
