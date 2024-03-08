import { Router } from "express";
import {
  createMaterial,
  deteleMaterial,
  getMaterial,
  updateMaterial,
} from "../controllers/material.controller.js";

const router = Router();

// Routes
router.post("/", createMaterial);
router.put("/:id", updateMaterial);
router.get("/", getMaterial);
router.delete("/:id", deteleMaterial);

export default router;
