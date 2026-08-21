import { Router } from "express";

import { UploadImage } from "../controllers/upload.controller.js";
import multer from "multer";

const router = Router();

// Deliberately not gated by module.
//
// This endpoint serves three screens at once — a photograph on an event, on a
// pole, and the portrait on your own profile — so tying it to one module would
// either stop a Cliente changing their own picture or hand a Cliente the right
// to attach photographs to events. It writes a file and nothing else: the row
// that points at it is written by an endpoint that *is* gated, so an upload
// nobody can reference is an orphan the Archivos screen cleans up.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/", upload.single("file"), UploadImage);
// Routes

export default router;
