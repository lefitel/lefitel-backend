import { Router } from "express";
import {
  createCiudad,
  deleteCiudad,
  desarchivarCiudad,
  getCiudad,
  searchCiudad,
  updateCiudad,
} from "../controllers/ciudad.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("ciudades", "crear"), createCiudad);
router.put("/:id", requirePermission("ciudades", "editar"), updateCiudad);
router.patch("/:id/desarchivar", requirePermission("ciudades", "archivar"), desarchivarCiudad);
router.get("/", getCiudad);
router.get("/:id", searchCiudad);
router.delete("/:id", requirePermission("ciudades", "archivar"), deleteCiudad);

export default router;
