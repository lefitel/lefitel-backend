import { Router } from "express";
import {
  createPoste,
  deletePoste,
  desarchivarPoste,
  getPoste,
  searchPoste,
  updatePoste,
} from "../controllers/poste.controller.js";
import { getOpcionesPoste } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("postes", "crear"), createPoste);
router.put("/:id", requirePermission("postes", "editar"), updatePoste);
// Before `/:id`, and that is not style — see `routeOrder.test.ts`. `/opciones`
// is a literal, and Express matches layers in declaration order, so a literal
// declared after a parametric sibling never runs: the request would reach
// `searchPoste` with `id = "opciones"` instead.
router.get("/opciones", requirePermission("postes", "ver"), getOpcionesPoste);
router.get("/", getPoste);

router.get("/:id", searchPoste);
router.delete("/:id", requirePermission("postes", "archivar"), deletePoste);
router.patch("/:id/desarchivar", requirePermission("postes", "archivar"), desarchivarPoste);

export default router;
