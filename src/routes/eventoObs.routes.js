import { Router } from "express";
import {
  createEventoObs,
  deteleEventoObs,
  getEventoObs,
  updateEventoObs,
} from "../controllers/eventoObs.controller.js";

const router = Router();

// Routes
router.post("/", createEventoObs);
router.put("/:id", updateEventoObs);
router.get("/:id_evento", getEventoObs);
router.delete("/:id", deteleEventoObs);

export default router;
