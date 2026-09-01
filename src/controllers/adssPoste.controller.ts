import { Request, Response } from "express";
import { AdssPosteModel } from "../models/adssPoste.model.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const adssPosteLog = log("adssPoste");
const handler = makeHandler(adssPosteLog);

export const getAdssPoste = handler("getAdssPoste", async (req: Request, res: Response) => {
  const { id_poste } = req.params;

  const TempAdssPoste = await AdssPosteModel.findAll({
    where: { id_poste },
    order: [["id", "DESC"]],
  });
  res.status(200).json(TempAdssPoste);
});
