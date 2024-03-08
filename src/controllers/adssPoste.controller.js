import { AdssPosteModel } from "../models/adssPoste.model.js";

export async function getAdssPoste(req, res) {
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

export async function createAdssPoste(req, res) {
  try {
    const TempAdssPoste = await AdssPosteModel.create(req.body);
    res.status(200).json(TempAdssPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleAdssPoste(req, res) {
  const { id } = req.params;
  try {
    await AdssPosteModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
