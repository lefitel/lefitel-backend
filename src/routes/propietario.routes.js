import { Router } from "express";
import {
  createPropietario,
  detelePropietario,
  getPropietario,
  updatePropietario,
} from "../controllers/propietario.controller.js";

const router = Router();

// Routes
router.post("/", createPropietario);
router.put("/:id", updatePropietario);
router.get("/", getPropietario);
router.delete("/:id", detelePropietario);

export default router;
