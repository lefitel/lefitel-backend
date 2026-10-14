import { Router } from "express";
import {
  createTramo, deleteTramo, desarchivarTramo, getTramo, searchTramo, updateTramo,
} from "../controllers/tramo.controller.js";
import { getOpcionesTramo } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

router.post("/", requirePermission("tramos", "crear"), createTramo);
router.put("/:id", requirePermission("tramos", "editar"), updateTramo);
router.patch("/:id/restore", requirePermission("tramos", "archivar"), desarchivarTramo);
router.get("/", requirePermission("tramos", "ver"), getTramo);
// Before `/:id` — a literal declared after a parametric sibling never runs.
// See `routeOrder.test.ts`.
router.get("/options", requirePermission("tramos", "ver"), getOpcionesTramo);
router.get("/:id", requirePermission("tramos", "ver"), searchTramo);
router.delete("/:id", requirePermission("tramos", "archivar"), deleteTramo);

export default router;
