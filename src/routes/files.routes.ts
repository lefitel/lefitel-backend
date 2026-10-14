import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import {
  deleteFile,
  deleteOrphanFiles,
  getBrokenImageRefs,
  clearBrokenImageRefs,
  getEntityImageStats,
  getOrphanFiles,
} from "../controllers/files.controller.js";
import { UploadImage } from "../controllers/upload.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { uploadLimiter } from "../middleware/uploadLimiters.js";

const router = Router();

/** The ceiling, named because the refusal below quotes it back to the caller. */
const MAX_UPLOAD_MB = 5;

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

/**
 * Storing a file — `POST /api/upload/` until D1, and a verb mounted as a root
 * resource next to the noun that manages it.
 *
 * 🔴 **Deliberately not gated by module, and it is the one route in this router
 * that is not.** It serves three screens at once — a photograph on an incident,
 * one on a pole, and the portrait on your own profile — so tying it to
 * `archivos` would either stop a Cliente changing their own picture or hand a
 * Cliente the right to attach photographs to incidents. §3.7 of the API
 * standard carries it as one of four permanent exceptions, and
 * `routeGuards.test.ts` pins it by address in `GATE_NOT_APPLICABLE`, in both
 * directions: adding a gate here fails, and so does dropping the entry.
 *
 * Two things follow, and neither survives being "tidied up":
 *
 * - **Do not lift the gate onto the router.** The other six routes each ask for
 *   `archivos` themselves precisely so this one can differ.
 * - **Do not add `archivos.crear` to make it uniform.** That action does not
 *   exist: `20260826000004-drop-dead-permission-cells` deleted those rows, and
 *   `matrix.ts` declares `archivos` as `ver` and `archivar` only. Asking for it
 *   is a 403 for every role, administrator included.
 *
 * It writes a file and nothing else: the row that points at it is written by an
 * endpoint that *is* gated, so an upload nobody can reference is an orphan the
 * Archivos screen cleans up — with the two routes above.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

// `uploadLimiter` before `multer`, and the order is the point: `memoryStorage`
// reads the whole five megabytes into memory before any handler runs, so a
// request that is already over budget has to be turned away in front of it. The
// budget itself, and why an endpoint outside the permission matrix needs one,
// are in `middleware/uploadLimiters.ts`.
//
// 🔴 On the route and never on the router. As `router.use(uploadLimiter)` the
// same thirty requests a minute would be spent by the Archivos screen, which
// costs three of them every time it opens — and the budget that exists to ration
// writing files to disk would run out browsing orphans.
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
 * 🔴 Mounted after the route, and at the end of this file, on purpose. Express
 * hands an error to the next error-handling layer *after* the one that threw,
 * so moved above `router.post` it silently stops running and the 413 goes back
 * to being a generic 500. It sees only what `upload.single` rejected: the six
 * routes above are wrapped in `makeHandler`, which answers its own failures and
 * never delegates here, and anything that is not multer's is passed on
 * untouched.
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
