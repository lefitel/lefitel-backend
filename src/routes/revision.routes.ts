import { Router } from "express";
import {
  createRevision,
  deleteRevision,
  getRevision,
  updateRevision,
} from "../controllers/revision.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
router.post("/", requirePermission("eventos", "crear"), createRevision);
router.put("/:id", requirePermission("eventos", "editar"), updateRevision);
router.get("/:id_evento", getRevision);
router.delete("/:id", requirePermission("eventos", "archivar"), deleteRevision);

export default router;
