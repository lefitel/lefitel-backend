import { Router } from "express";
import {
  createObs,
  deleteObs,
  desarchivarObs,
  getObs,
  getObsStats,
  updateObs,
} from "../controllers/obs.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("parametros", "crear"), createObs);
router.put("/:id", requirePermission("parametros", "editar"), updateObs);
router.patch("/:id/desarchivar", requirePermission("parametros", "archivar"), desarchivarObs);
router.get("/stats", requirePermission("parametros", "ver"), getObsStats);
router.get("/", getObs);
router.delete("/:id", requirePermission("parametros", "archivar"), deleteObs);

export default router;
