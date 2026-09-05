import { Router } from "express";
import {
  createEvento,
  deleteEvento,
  desarchivarEvento,
  exportarEventos,
  getEvento,
  reabrirEvento,
  resolverEvento,
  searchEvento,
  updateEvento,
} from "../controllers/evento.controller.js";
// D1 (§3.2): three listings that only exist with respect to one incident now
// hang off it, and their own mounts are gone. The controllers stayed where they
// were — they read one model each and moving them would buy nothing.
import { getEventoObs } from "../controllers/eventoObs.controller.js";
import { getRevision } from "../controllers/revision.controller.js";
import { getSolucion_evento } from "../controllers/solucion.controller.js";
import { getOpcionesEvento } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { exportLimiter } from "../middleware/limiters.js";

const router = Router();

// Routes
router.post("/", requirePermission("eventos", "crear"), createEvento);
router.post("/:id/reopen", requirePermission("eventos", "editar"), reabrirEvento);
router.post("/:id/resolve", requirePermission("eventos", "editar"), resolverEvento);
router.put("/:id", requirePermission("eventos", "editar"), updateEvento);
// Before `/:id`, and that is not style — see `routeOrder.test.ts`. `/options`
// is a literal, and Express matches layers in declaration order, so a literal
// declared after a parametric sibling never runs: the request would reach
// `searchEvento` with `id = "options"` instead.
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
router.get("/options", requirePermission("eventos", "ver"), getOpcionesEvento);
// C5: these answered any session until then, whatever its role.
router.get("/", requirePermission("eventos", "ver"), getEvento);
router.get("/:id", requirePermission("eventos", "ver"), searchEvento);

// The three that belong to one incident. Declared after `/:id` and that is
// safe rather than lucky: `/:id` is one segment and cannot match two, in
// Express 4 or 5. They were `/api/eventoObs/:id_evento`, `/api/revision/:id_evento`
// and `/api/solucion/evento/:id_evento`, three root mounts for things that only
// exist with respect to an incident.
//
// 🔴 The parameter is `:id` here and the controllers were changed with the
// routes, in the same commit. Left reading `id_evento` they build
// `where: {id_evento: undefined}`, which Postgres refuses.
//
// What sees it is not the same for the three. `/obs` and `/revisiones` are in
// the `LISTADOS` block of `listShape.test.ts`, which really does request them.
// **`/solucion` is not** — it is filed under `AGREGADAS`, a group that file
// lists and never asks for — so until D1 no test in either repository sent a
// request to that address. It is also the one where breaking it is silent: both
// callers in `web` wrap it in `.catch(() => null)`, and `null` is its ordinary
// answer, so a 500 there paints every repaired incident as still open with
// nothing on screen. `solucion.evento.test.ts` was written for exactly that.
router.get("/:id/obs", requirePermission("eventos", "ver"), getEventoObs);
router.get("/:id/revisiones", requirePermission("eventos", "ver"), getRevision);
router.get("/:id/solucion", requirePermission("eventos", "ver"), getSolucion_evento);

router.delete("/:id", requirePermission("eventos", "archivar"), deleteEvento);
router.patch("/:id/restore", requirePermission("eventos", "archivar"), desarchivarEvento);

export default router;
