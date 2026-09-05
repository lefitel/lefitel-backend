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
// D1 (§3.2): two listings that only exist with respect to one pole now hang off
// it. `/api/adssposte` was a root mount for the first and is gone; the second
// was `GET /api/evento/poste/:id_poste`, under the wrong parent.
import { getAdssPoste } from "../controllers/adssPoste.controller.js";
import { getEvento_poste } from "../controllers/evento.controller.js";
import { getOpcionesPoste } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { exportLimiter } from "../middleware/limiters.js";

const router = Router();

// Routes
router.post("/", requirePermission("postes", "crear"), createPoste);
router.put("/:id", requirePermission("postes", "editar"), updatePoste);
// Before `/:id`, and that is not style — see `routeOrder.test.ts`. `/options`
// is a literal, and Express matches layers in declaration order, so a literal
// declared after a parametric sibling never runs: the request would reach
// `searchPoste` with `id = "options"` instead.
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
router.get("/options", requirePermission("postes", "ver"), getOpcionesPoste);
// C5: the register and one pole of it. Both answered any session until then,
// whatever its role. What this removes is ambient reach, not the data — the
// dashboard still hands the whole register to anyone with `eventos.ver`, and
// the generator serves poles to `generador.ver`. §6 of the spec says so.
router.get("/", requirePermission("postes", "ver"), getPoste);

router.get("/:id", requirePermission("postes", "ver"), searchPoste);

// The two that belong to one pole. Safe after `/:id` rather than lucky: `/:id`
// is one segment and cannot match two.
//
// 🔴 The parameter is `:id` here, and both controllers were changed with the
// routes in the same commit — left reading `id_poste` they build
// `where: {id_poste: undefined}`, which Postgres refuses. The pair on the
// incidents of a pole stays `eventos.ver`: the question is about the work, and
// changing parent does not change what is being asked.
router.get("/:id/adss", requirePermission("postes", "ver"), getAdssPoste);
router.get("/:id/eventos", requirePermission("eventos", "ver"), getEvento_poste);

router.delete("/:id", requirePermission("postes", "archivar"), deletePoste);
router.patch("/:id/restore", requirePermission("postes", "archivar"), desarchivarPoste);

export default router;
