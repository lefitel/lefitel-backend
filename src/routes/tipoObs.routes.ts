import { Router } from "express";
import {
  createTipoObs,
  deleteTipoObs,
  desarchivarTipoObs,
  getTipoObs,
  updateTipoObs,
} from "../controllers/tipoObs.controller.js";

const router = Router();

// Routes
router.post("/", createTipoObs);
router.put("/:id", updateTipoObs);
router.patch("/:id/desarchivar", desarchivarTipoObs);
router.get("/", getTipoObs);
router.delete("/:id", deleteTipoObs);

export default router;
