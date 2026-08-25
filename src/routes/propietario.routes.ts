import { Router } from "express";
import {
  createPropietario,
  deletePropietario,
  desarchivarPropietario,
  getPropietario,
  getPropietarioStats,
  updatePropietario,
} from "../controllers/propietario.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("parametros", "crear"), createPropietario);
router.put("/:id", requirePermission("parametros", "editar"), updatePropietario);
router.patch("/:id/desarchivar", requirePermission("parametros", "archivar"), desarchivarPropietario);
router.get("/stats", requirePermission("parametros", "ver"), getPropietarioStats);
router.get("/", getPropietario);
router.delete("/:id", requirePermission("parametros", "archivar"), deletePropietario);

export default router;
