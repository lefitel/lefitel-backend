import { Router } from "express";
import {
  createAdss,
  deleteAdss,
  desarchivarAdss,
  getAdss,
  getAdssStats,
  updateAdss,
} from "../controllers/adss.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("parametros", "crear"), createAdss);
router.put("/:id", requirePermission("parametros", "editar"), updateAdss);
router.patch("/:id/desarchivar", requirePermission("parametros", "archivar"), desarchivarAdss);
router.get("/stats", requirePermission("parametros", "ver"), getAdssStats);
router.get("/", getAdss);
router.delete("/:id", requirePermission("parametros", "archivar"), deleteAdss);

export default router;
