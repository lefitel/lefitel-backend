import { Router } from "express";
import { getEventoObs } from "../controllers/eventoObs.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

router.get("/:id_evento", requirePermission("eventos", "ver"), getEventoObs);

export default router;
