import { Router } from "express";
import {
  createPoste,
  deletePoste,
  desarchivarPoste,
  getPoste,
  getTramos,
  searchPoste,
  updatePoste,
} from "../controllers/poste.controller.js";

const router = Router();

// Routes
router.post("/", createPoste);
router.put("/:id", updatePoste);
router.get("/tramos", getTramos);
router.get("/", getPoste);

router.get("/:id", searchPoste);
router.delete("/:id", deletePoste);
router.patch("/:id/desarchivar", desarchivarPoste);

export default router;
