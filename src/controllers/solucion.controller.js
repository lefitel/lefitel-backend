import { SolucionModel } from "../models/solucion.model.js";

export async function getSolucion(req, res) {
  try {
    const TempSolucion = await SolucionModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getSolucion_evento(req, res) {
  const { id_evento } = req.params;

  try {
    const TempSolucion = await SolucionModel.findOne({
      where: { id_evento },
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createSolucion(req, res) {
  try {
    const TempSolucion = await SolucionModel.create(req.body);
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateSolucion(req, res) {
  const { id } = req.params;
  try {
    const TempSolucion = await SolucionModel.findOne({
      where: { id },
    });
    TempSolucion.set(req.body);
    await TempSolucion.save();
    res.status(200).json(TempSolucion);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleSolucion(req, res) {
  const { id } = req.params;
  try {
    await SolucionModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
