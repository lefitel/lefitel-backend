import { Router } from "express";
import {
  createSolucion,
  deleteSolucion,
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

router.delete("/:id", deleteSolucion);

export default router;
