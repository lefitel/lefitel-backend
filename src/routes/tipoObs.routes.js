import { Router } from "express";
import {
  createTipoObs,
  deteleTipoObs,
  getTipoObs,
  updateTipoObs,
} from "../controllers/tipoObs.controller.js";

const router = Router();

// Routes
router.post("/", createTipoObs);
router.put("/:id", updateTipoObs);
router.get("/", getTipoObs);
router.delete("/:id", deteleTipoObs);

export default router;
