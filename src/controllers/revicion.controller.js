import { RevicionModel } from "../models/revicion.model.js";

export async function getRevicion(req, res) {
  const { id_evento } = req.params;

  try {
    const TempRevicion = await RevicionModel.findAll({
      where: { id_evento },

      order: [["id", "DESC"]],
    });
    res.status(200).json(TempRevicion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createRevicion(req, res) {
  try {
    const TempRevicion = await RevicionModel.create(req.body);
    res.status(200).json(TempRevicion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateRevicion(req, res) {
  const { id } = req.params;
  if (id) {
    try {
      const TempRevicion = await RevicionModel.findOne({
        where: { id },
      });
      TempRevicion.set(req.body);
      await TempRevicion.save();
      res.status(200).json(TempRevicion);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  } else {
    try {
      const TempRevicion = await RevicionModel.create(req.body);
      res.status(200).json(TempRevicion);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
}
export async function deteleRevicion(req, res) {
  const { id } = req.params;
  try {
    await RevicionModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
