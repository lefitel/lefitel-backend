import { Router } from "express";
import { getAdssPoste } from "../controllers/adssPoste.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

router.get("/:id_poste", requirePermission("postes", "ver"), getAdssPoste);

export default router;
