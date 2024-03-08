import { Router } from "express";
import {
  createSolucion,
  deteleSolucion,
  getSolucion,
  getSolucion_evento,
  updateSolucion,
} from "../controllers/solucion.controller.js";

const router = Router();

// Routes
router.post("/", createSolucion);
router.put("/:id", updateSolucion);
router.get("/", getSolucion);
router.get("/evento/:id_evento", getSolucion_evento);

router.delete("/:id", deteleSolucion);

export default router;
