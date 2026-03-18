import { Router } from "express";
import {
  createAdss,
  deleteAdss,
  desarchivarAdss,
  getAdss,
  updateAdss,
} from "../controllers/adss.controller.js";

const router = Router();

// Routes
router.post("/", createAdss);
router.put("/:id", updateAdss);
router.patch("/:id/desarchivar", desarchivarAdss);
router.get("/", getAdss);
router.delete("/:id", deleteAdss);

export default router;
