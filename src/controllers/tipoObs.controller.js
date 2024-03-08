import { TipoObsModel } from "../models/tipoObs.model.js";

export async function getTipoObs(req, res) {
  try {
    const TempTipoObs = await TipoObsModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createTipoObs(req, res) {
  try {
    const TempTipoObs = await TipoObsModel.create(req.body);
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateTipoObs(req, res) {
  const { id } = req.params;
  try {
    const TempTipoObs = await TipoObsModel.findOne({
      where: { id },
    });
    TempTipoObs.set(req.body);
    await TempTipoObs.save();
    res.status(200).json(TempTipoObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleTipoObs(req, res) {
  const { id } = req.params;
  try {
    await TipoObsModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
