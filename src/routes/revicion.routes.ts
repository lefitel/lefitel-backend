import { Router } from "express";
import {
  createRevicion,
  deleteRevicion,
  getRevicion,
  updateRevicion,
} from "../controllers/revicion.controller.js";

const router = Router();

// Routes
router.post("/", createRevicion);
router.put("/:id", updateRevicion);
router.get("/:id_evento", getRevicion);
router.delete("/:id", deleteRevicion);

export default router;
