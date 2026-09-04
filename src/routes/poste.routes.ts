import { Router } from "express";
import {
  createPoste,
  deletePoste,
  desarchivarPoste,
  exportarPostes,
  getPoste,
  searchPoste,
  updatePoste,
} from "../controllers/poste.controller.js";
import { getOpcionesPoste } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { exportLimiter } from "../middleware/limiters.js";

const router = Router();

// Routes
router.post("/", requirePermission("postes", "crear"), createPoste);
router.put("/:id", requirePermission("postes", "editar"), updatePoste);
// Before `/:id`, and that is not style — see `routeOrder.test.ts`. `/opciones`
// is a literal, and Express matches layers in declaration order, so a literal
// declared after a parametric sibling never runs: the request would reach
// `searchPoste` with `id = "opciones"` instead.
/**
 * The list as a file.
 *
 * **POST, for a download.** `requireSameOrigin` only guards the writing verbs,
 * so a GET that assembles a spreadsheet is something any page on the internet
 * can make a logged-in employee's browser do, twenty times over, from an
 * `<img>` tag it never gets to read. Nothing is stolen; the server just spends
 * somebody else's memory and the only export slot it has. The report
 * generator's own export is a POST for this reason.
 *
 * The filters ride in the query string all the same, because they are the
 * listing's own parameters read by the listing's own function — see
 * `filtroDe*` in the controller.
 *
 * `exportLimiter` is shared with the generator on purpose: what is being
 * rationed is the one slot that builds documents, and a per-route budget would
 * let one person hold it four times over by rotating between the routes.
 */
router.post("/export", requirePermission("postes", "ver"), exportLimiter, exportarPostes);
router.get("/opciones", requirePermission("postes", "ver"), getOpcionesPoste);
router.get("/", getPoste);

router.get("/:id", searchPoste);
router.delete("/:id", requirePermission("postes", "archivar"), deletePoste);
router.patch("/:id/desarchivar", requirePermission("postes", "archivar"), desarchivarPoste);

export default router;
