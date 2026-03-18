import { Router } from "express";
import {
  createPropietario,
  deletePropietario,
  desarchivarPropietario,
  getPropietario,
  updatePropietario,
} from "../controllers/propietario.controller.js";

const router = Router();

// Routes
router.post("/", createPropietario);
router.put("/:id", updatePropietario);
router.patch("/:id/desarchivar", desarchivarPropietario);
router.get("/", getPropietario);
router.delete("/:id", deletePropietario);

export default router;
