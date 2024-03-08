import { EventoModel } from "../models/evento.model.js";
import { PosteModel } from "../models/poste.model.js";

export async function getEvento(req, res) {
  try {
    const TempEvento = await EventoModel.findAll({
      order: [["id", "DESC"]],
      include: [{ model: PosteModel }],
    });
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getEvento_poste(req, res) {
  const { id_poste } = req.params;

  try {
    const TempEvento = await EventoModel.findAll({
      where: { id_poste },
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function searchEvento(req, res) {
  const { id } = req.params;
  try {
    const TempEvento = await EventoModel.findOne({
      where: { id },
    });
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createEvento(req, res) {
  try {
    const TempEvento = await EventoModel.create(req.body);
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateEvento(req, res) {
  const { id } = req.params;
  try {
    const TempEvento = await EventoModel.findOne({
      where: { id },
    });
    TempEvento.set(req.body);
    await TempEvento.save();
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleEvento(req, res) {
  const { id } = req.params;
  try {
    await EventoModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
