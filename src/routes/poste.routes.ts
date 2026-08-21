import { Router } from "express";
import {
  createPoste,
  deletePoste,
  desarchivarPoste,
  getPoste,
  getTramos,
  searchPoste,
  updatePoste,
} from "../controllers/poste.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("postes", "crear"), createPoste);
router.put("/:id", requirePermission("postes", "editar"), updatePoste);
router.get("/tramos", getTramos);
router.get("/", getPoste);

router.get("/:id", searchPoste);
router.delete("/:id", requirePermission("postes", "archivar"), deletePoste);
router.patch("/:id/desarchivar", requirePermission("postes", "archivar"), desarchivarPoste);

export default router;
