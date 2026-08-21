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
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("eventos", "crear"), createEvento);
router.post("/:id/reabrir", requirePermission("eventos", "editar"), reabrirEvento);
router.post("/:id/resolver", requirePermission("eventos", "editar"), resolverEvento);
router.put("/:id", requirePermission("eventos", "editar"), updateEvento);
router.get("/", getEvento);
router.get("/poste/:id_poste", getEvento_poste);
router.get("/usuario/:id_usuario", getEvento_usuario);
router.get("/:id", searchEvento);

router.delete("/:id", requirePermission("eventos", "archivar"), deleteEvento);
router.patch("/:id/desarchivar", requirePermission("eventos", "archivar"), desarchivarEvento);

export default router;
