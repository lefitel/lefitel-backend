import { Router } from "express";
import {
  createEvento,
  deleteEvento,
  desarchivarEvento,
  exportarEventos,
  getEvento,
  getEvento_poste,
  getEvento_usuario,
  reabrirEvento,
  resolverEvento,
  searchEvento,
  updateEvento,
} from "../controllers/evento.controller.js";
import { getOpcionesEvento } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { exportLimiter } from "../middleware/limiters.js";

const router = Router();

// Routes
router.post("/", requirePermission("eventos", "crear"), createEvento);
router.post("/:id/reabrir", requirePermission("eventos", "editar"), reabrirEvento);
router.post("/:id/resolver", requirePermission("eventos", "editar"), resolverEvento);
router.put("/:id", requirePermission("eventos", "editar"), updateEvento);
// Before `/:id`, and that is not style — see `routeOrder.test.ts`. `/opciones`
// is a literal, and Express matches layers in declaration order, so a literal
// declared after a parametric sibling never runs: the request would reach
// `searchEvento` with `id = "opciones"` instead.
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
router.post("/export", requirePermission("eventos", "ver"), exportLimiter, exportarEventos);
router.get("/opciones", requirePermission("eventos", "ver"), getOpcionesEvento);
router.get("/", getEvento);
router.get("/poste/:id_poste", getEvento_poste);
router.get("/usuario/:id_usuario", getEvento_usuario);
router.get("/:id", searchEvento);

router.delete("/:id", requirePermission("eventos", "archivar"), deleteEvento);
router.patch("/:id/desarchivar", requirePermission("eventos", "archivar"), desarchivarEvento);

export default router;
