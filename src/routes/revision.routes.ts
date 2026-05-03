import { Router } from "express";
import {
  createRevision,
  deleteRevision,
  getRevision,
  updateRevision,
} from "../controllers/revision.controller.js";

const router = Router();

// Routes
router.post("/", createRevision);
router.put("/:id", updateRevision);
router.get("/:id_evento", getRevision);
router.delete("/:id", deleteRevision);

export default router;
