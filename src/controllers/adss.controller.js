import { AdssModel } from "../models/adss.model.js";

export async function getAdss(req, res) {
  try {
    const TempAdss = await AdssModel.findAll({
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function createAdss(req, res) {
  try {
    const TempAdss = await AdssModel.create(req.body);
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateAdss(req, res) {
  const { id } = req.params;
  try {
    const TempAdss = await AdssModel.findOne({
      where: { id },
    });
    TempAdss.set(req.body);
    await TempAdss.save();
    res.status(200).json(TempAdss);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deteleAdss(req, res) {
  const { id } = req.params;
  try {
    await AdssModel.destroy({
      where: { id },
    });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
