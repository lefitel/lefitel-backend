import { Router } from "express";
import {
  createObs,
  deleteObs,
  desarchivarObs,
  getObs,
  getObsStats,
  updateObs,
} from "../controllers/obs.controller.js";

const router = Router();

// Routes
router.post("/", createObs);
router.put("/:id", updateObs);
router.patch("/:id/desarchivar", desarchivarObs);
router.get("/stats", getObsStats);
router.get("/", getObs);
router.delete("/:id", deleteObs);

export default router;
