import { Router } from "express";
import {
  createRol,
  deleteRol,
  getRol,
  updateRol,
} from "../controllers/rol.controller.js";

const router = Router();

// Routes
router.post("/", createRol);
router.put("/:id", updateRol);
router.get("/", getRol);
router.delete("/:id", deleteRol);

export default router;
