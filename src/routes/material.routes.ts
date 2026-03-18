import { Router } from "express";
import {
  createMaterial,
  deleteMaterial,
  desarchivarMaterial,
  getMaterial,
  updateMaterial,
} from "../controllers/material.controller.js";

const router = Router();

// Routes
router.post("/", createMaterial);
router.put("/:id", updateMaterial);
router.patch("/:id/desarchivar", desarchivarMaterial);
router.get("/", getMaterial);
router.delete("/:id", deleteMaterial);

export default router;
