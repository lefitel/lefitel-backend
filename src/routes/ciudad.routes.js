import { Router } from "express";
import {
  createCiudad,
  deteleCiudad,
  getCiudad,
  updateCiudad,
} from "../controllers/ciudad.controller.js";

const router = Router();

// Routes
router.post("/", createCiudad);
router.put("/:id", updateCiudad);
router.get("/", getCiudad);
router.delete("/:id", deteleCiudad);

export default router;
