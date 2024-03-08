import { Router } from "express";
import {
  createBitacora,
  getBitacora,
} from "../controllers/bitacora.controller.js";

const router = Router();

// Routes
router.post("/", createBitacora);
router.get("/:id_usuario", getBitacora);

export default router;
