import { Router } from "express";
import {
  createObs,
  deteleObs,
  getObs,
  updateObs,
} from "../controllers/obs.controller.js";

const router = Router();

// Routes
router.post("/", createObs);
router.put("/:id", updateObs);
router.get("/", getObs);
router.delete("/:id", deteleObs);

export default router;
