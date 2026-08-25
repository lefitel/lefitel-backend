import { Router } from "express";
import {
  createTipoObs,
  deleteTipoObs,
  desarchivarTipoObs,
  getTipoObs,
  getTipoObsStats,
  updateTipoObs,
} from "../controllers/tipoObs.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("parametros", "crear"), createTipoObs);
router.put("/:id", requirePermission("parametros", "editar"), updateTipoObs);
router.patch("/:id/desarchivar", requirePermission("parametros", "archivar"), desarchivarTipoObs);
router.get("/stats", requirePermission("parametros", "ver"), getTipoObsStats);
router.get("/", getTipoObs);
router.delete("/:id", requirePermission("parametros", "archivar"), deleteTipoObs);

export default router;
