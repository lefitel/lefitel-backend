import { Router } from "express";
import {
  createAdss,
  deteleAdss,
  getAdss,
  updateAdss,
} from "../controllers/adss.controller.js";

const router = Router();

// Routes
router.post("/", createAdss);
router.put("/:id", updateAdss);
router.get("/", getAdss);
router.delete("/:id", deteleAdss);

export default router;
