import { Router } from "express";
import {
  createEvento,
  deteleEvento,
  getEvento,
  getEvento_poste,
  searchEvento,
  updateEvento,
} from "../controllers/evento.controller.js";

const router = Router();

// Routes
router.post("/", createEvento);
router.put("/:id", updateEvento);
router.get("/", getEvento);
router.get("/:id", searchEvento);

router.get("/poste/:id_poste", getEvento_poste);

router.delete("/:id", deteleEvento);

export default router;
