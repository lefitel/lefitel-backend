import { Router } from "express";

import { UploadImage } from "../controllers/upload.controller.js";
import multer from "multer";

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/", upload.single("file"), UploadImage);
// Routes

export default router;
