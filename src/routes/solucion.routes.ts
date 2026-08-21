import { Router } from "express";
import {
  createSolucion,
  deleteSolucion,
  getSolucion,
  getSolucion_evento,
  updateSolucion,
} from "../controllers/solucion.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("eventos", "crear"), createSolucion);
router.put("/:id", requirePermission("eventos", "editar"), updateSolucion);
router.get("/", getSolucion);
router.get("/evento/:id_evento", getSolucion_evento);

router.delete("/:id", requirePermission("eventos", "archivar"), deleteSolucion);

export default router;
