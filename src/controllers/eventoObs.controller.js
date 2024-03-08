import { EventoObsModel } from "../models/eventoObs.model.js";

export async function getEventoObs(req, res) {
  const { id_evento } = req.params;

  try {
    const TempEventoObs = await EventoObsModel.findAll({
      where: { id_evento },

      order: [["id", "DESC"]],
    });
    res.status(200).json(TempEventoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createEventoObs(req, res) {
  try {
    const TempEventoObs = await EventoObsModel.create(req.body);
    res.status(200).json(TempEventoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateEventoObs(req, res) {
  const { id } = req.params;
  try {
    const TempEventoObs = await EventoObsModel.findOne({
      where: { id },
    });
    TempEventoObs.set(req.body);
    await TempEventoObs.save();
    res.status(200).json(TempEventoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleEventoObs(req, res) {
  const { id } = req.params;
  try {
    await EventoObsModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
