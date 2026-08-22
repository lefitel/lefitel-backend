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
//
// Recording an inspection is `editar`, not `crear`: the incident already exists
// and this is work done to it, the same call `POST /api/evento/:id/resolver`
// makes. `crear` is reserved for opening an incident that did not exist.
//
// It asked for `crear` until now, while every button that offers it asked the
// browser for `editar` — so a role holding `ver` + `editar` without `crear` saw
// the button, wrote the inspection, and got a 403 the interface reported as
// success. See AddRevisionSheet on the other side of that.
router.post("/", requirePermission("eventos", "editar"), createRevision);
router.put("/:id", requirePermission("eventos", "editar"), updateRevision);
router.get("/:id_evento", getRevision);
router.delete("/:id", requirePermission("eventos", "archivar"), deleteRevision);

export default router;
