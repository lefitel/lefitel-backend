import { Router } from "express";
import {
  deleteFile,
  deleteOrphanFiles,
  getFiles,
  getOrphanFiles,
} from "../controllers/files.controller.js";

const router = Router();

router.get("/", getFiles);
router.get("/orphans", getOrphanFiles);
router.delete("/orphans", deleteOrphanFiles);
router.delete("/:name", deleteFile);

export default router;
