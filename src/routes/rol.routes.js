import { Router } from "express";
import {
  createRol,
  deteleRol,
  getRol,
  updateRol,
} from "../controllers/rol.controller.js";

const router = Router();

// Routes
router.post("/", createRol);
router.put("/:id", updateRol);
router.get("/", getRol);
router.delete("/:id", deteleRol);

export default router;
