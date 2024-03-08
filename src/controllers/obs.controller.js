import { ObsModel } from "../models/obs.model.js";

export async function getObs(req, res) {
  try {
    const TempObs = await ObsModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createObs(req, res) {
  try {
    const TempObs = await ObsModel.create(req.body);
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateObs(req, res) {
  const { id } = req.params;
  try {
    const TempObs = await ObsModel.findOne({
      where: { id },
    });
    TempObs.set(req.body);
    await TempObs.save();
    res.status(200).json(TempObs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleObs(req, res) {
  const { id } = req.params;
  try {
    await ObsModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
