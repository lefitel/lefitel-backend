import { Router } from "express";
import {
  createPoste,
  detelePoste,
  getPoste,
  searchPoste,
  updatePoste,
} from "../controllers/poste.controller.js";

const router = Router();

// Routes
router.post("/", createPoste);
router.put("/:id", updatePoste);
router.get("/", getPoste);

router.get("/:id", searchPoste);
router.delete("/:id", detelePoste);

export default router;
