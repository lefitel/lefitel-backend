import { Router, type NextFunction, type Request, type Response } from "express";

import { UploadImage } from "../controllers/upload.controller.js";
import multer from "multer";
import { uploadLimiter } from "../middleware/uploadLimiters.js";

const router = Router();

/** The ceiling, named because the refusal below quotes it back to the caller. */
export const MAX_UPLOAD_MB = 5;

// Deliberately not gated by module.
//
// This endpoint serves three screens at once — a photograph on an event, on a
// pole, and the portrait on your own profile — so tying it to one module would
// either stop a Cliente changing their own picture or hand a Cliente the right
// to attach photographs to events. It writes a file and nothing else: the row
// that points at it is written by an endpoint that *is* gated, so an upload
// nobody can reference is an orphan the Archivos screen cleans up.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

// `uploadLimiter` before `multer`, and the order is the point: `memoryStorage`
// reads the whole five megabytes into memory before any handler runs, so a
// request that is already over budget has to be turned away in front of it. The
// budget itself, and why an endpoint outside the permission matrix needs one,
// are in `middleware/uploadLimiters.ts`.
router.post("/", uploadLimiter, upload.single("file"), UploadImage);

/**
 * Multer's own refusals, answered as the caller's mistake rather than ours.
 *
 * A `MulterError` carries a `code` and no `status`, so the terminal handler in
 * `app.ts` — which reads `err.status` and otherwise assumes 500 — turned each of
 * them into "Ocurrió un error al procesar la petición". A photograph over the
 * limit is the common one and the case where saying so is worth the most: the
 * alternative is a technician in the field retrying the same file, because
 * nothing in the answer suggests a different one would work.
 *
 * Mounted after the route on purpose. Express hands an error to the next
 * error-handling layer *after* the one that threw, so this sees what
 * `upload.single` rejected and nothing else. Anything that is not multer's is
 * passed on untouched and still ends up a 500, which for anything else is right.
 */
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!(err instanceof multer.MulterError)) return next(err);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      message: `La imagen supera el máximo de ${MAX_UPLOAD_MB} MB. Tome o elija una más liviana.`,
    });
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ message: "El archivo se envió en un campo que no corresponde." });
  }
  return res.status(400).json({ message: "No se pudo leer el archivo enviado." });
});

export default router;
