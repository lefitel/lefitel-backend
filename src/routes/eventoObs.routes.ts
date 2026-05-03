import { Router } from "express";
import { getEventoObs } from "../controllers/eventoObs.controller.js";

const router = Router();

router.get("/:id_evento", getEventoObs);

export default router;
