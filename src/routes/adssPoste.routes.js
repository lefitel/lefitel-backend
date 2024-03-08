import { Router } from "express";
import {
  createAdssPoste,
  deteleAdssPoste,
  getAdssPoste,
} from "../controllers/adssPoste.controller.js";

const router = Router();

// Routes
router.post("/", createAdssPoste);
router.get("/:id_poste", getAdssPoste);
router.delete("/:id", deteleAdssPoste);

export default router;
