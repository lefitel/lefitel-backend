import { Router } from "express";
import {
  createCiudad,
  deleteCiudad,
  desarchivarCiudad,
  getCiudad,
  searchCiudad,
  updateCiudad,
} from "../controllers/ciudad.controller.js";

const router = Router();

// Routes
router.post("/", createCiudad);
router.put("/:id", updateCiudad);
router.patch("/:id/desarchivar", desarchivarCiudad);
router.get("/", getCiudad);
router.get("/:id", searchCiudad);
router.delete("/:id", deleteCiudad);

export default router;
