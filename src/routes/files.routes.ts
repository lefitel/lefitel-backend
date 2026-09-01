import { Router } from "express";
import {
  deleteFile,
  deleteOrphanFiles,
  getBrokenImageRefs,
  clearBrokenImageRefs,
  getEntityImageStats,
  getOrphanFiles,
} from "../controllers/files.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// The gate used to sit on the mount in app.ts as `requireRole(1)`, which drew no
// line between listing files and deleting them. Reading the module and erasing
// its contents are different permissions, so they are asked for separately.
// No bare `GET /`. `/orphans` below returns the same `readDiskFiles()` plus
// whether each file is used and by what — a strict superset, behind the same
// permission. See §7 of the API standard spec.
router.get("/orphans", requirePermission("archivos", "ver"), getOrphanFiles);
router.delete("/orphans", requirePermission("archivos", "archivar"), deleteOrphanFiles);
router.get("/entity-stats", requirePermission("archivos", "ver"), getEntityImageStats);
router.get("/broken-refs", requirePermission("archivos", "ver"), getBrokenImageRefs);
router.delete("/broken-refs", requirePermission("archivos", "archivar"), clearBrokenImageRefs);
router.delete("/:name", requirePermission("archivos", "archivar"), deleteFile);

export default router;
