import { Router } from "express";
import {
  createAdssPoste,
  deleteAdssPoste,
  getAdssPoste,
} from "../controllers/adssPoste.controller.js";

const router = Router();

// Routes
router.post("/", createAdssPoste);
router.get("/:id_poste", getAdssPoste);
router.delete("/:id", deleteAdssPoste);

export default router;
