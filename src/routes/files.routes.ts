import { Router } from "express";
import {
  deleteFile,
  deleteOrphanFiles,
  getBrokenImageRefs,
  clearBrokenImageRefs,
  getEntityImageStats,
  getFiles,
  getOrphanFiles,
} from "../controllers/files.controller.js";

const router = Router();

router.get("/", getFiles);
router.get("/orphans", getOrphanFiles);
router.delete("/orphans", deleteOrphanFiles);
router.get("/entity-stats", getEntityImageStats);
router.get("/broken-refs", getBrokenImageRefs);
router.delete("/broken-refs", clearBrokenImageRefs);
router.delete("/:name", deleteFile);

export default router;
