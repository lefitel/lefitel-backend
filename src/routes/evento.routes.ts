import { Router } from "express";
import {
  createEvento,
  deleteEvento,
  desarchivarEvento,
  getEvento,
  getEvento_poste,
  getEvento_usuario,
  reabrirEvento,
  resolverEvento,
  searchEvento,
  updateEvento,
} from "../controllers/evento.controller.js";

const router = Router();

// Routes
router.post("/", createEvento);
router.post("/:id/reabrir", reabrirEvento);
router.post("/:id/resolver", resolverEvento);
router.put("/:id", updateEvento);
router.get("/", getEvento);
router.get("/poste/:id_poste", getEvento_poste);
router.get("/usuario/:id_usuario", getEvento_usuario);
router.get("/:id", searchEvento);

router.delete("/:id", deleteEvento);
router.patch("/:id/desarchivar", desarchivarEvento);

export default router;
