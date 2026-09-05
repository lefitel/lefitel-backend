import { Router } from "express";
import {
  createMaterial,
  deleteMaterial,
  desarchivarMaterial,
  getMaterial,
  getMaterialStats,
  updateMaterial,
} from "../controllers/material.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("parametros", "crear"), createMaterial);
router.put("/:id", requirePermission("parametros", "editar"), updateMaterial);
router.patch("/:id/restore", requirePermission("parametros", "archivar"), desarchivarMaterial);
router.get("/stats", requirePermission("parametros", "ver"), getMaterialStats);
router.get("/", requirePermission("parametros", "ver"), getMaterial);
router.delete("/:id", requirePermission("parametros", "archivar"), deleteMaterial);

export default router;
