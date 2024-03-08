import { Router } from "express";

import { UploadImage } from "../controllers/upload.controller.js";
import multer from "multer";

const router = Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    return cb(null, "./public/images");
  },
  filename: function (req, file, cb) {
    return cb(null, `${Date.now()}_${file.originalname}`);
  },
});

const upload = multer({ storage });
// Routes
router.post("/", upload.single("file"), UploadImage);

export default router;
