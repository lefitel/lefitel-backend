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
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";
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
// C5: these four answered any session until now, whatever its role.
router.get("/", requirePermission("eventos", "ver"), getEvento);
router.get("/poste/:id_poste", requirePermission("eventos", "ver"), getEvento_poste);
/**
 * The incidents of one person, and the only one of the eighteen that is not a
 * plain `requirePermission`.
 *
 * **`seguridad.ver`, not `eventos.ver`**, because the question is about a
 * person and not about the work: the Cliente role holds `eventos.ver`, so with
 * the obvious gate it could walk `/usuario/1` … `/usuario/20` and assemble each
 * employee's activity record. The same question already answers to
 * `seguridad.ver` in the generator, where `usuario` is a level of detail nobody
 * without it may root a report on.
 *
 * **And `requireSelfOrPermission`, because this is what the person's own
 * profile screen calls.** With the plain gate every non-administrator would
 * silently lose their own history — the profile swallows the failure and prints
 * "Eventos atendidos: 0".
 *
 * 🔴 The third argument is not optional. It defaults to `"id"`, this route's
 * parameter is `:id_usuario`, and with the default the ownership branch
 * compares `undefined` against the caller's id and never matches — the gate
 * degrades to permission-only and the screen above goes quiet. That defect has
 * already shipped once on the bitácora route, which is why the middleware's own
 * comment records it. `routeGuards.test.ts` cannot catch it (it never sends a
 * request) and neither can `listShape.test.ts` (it mocks every permission to
 * true); `evento.self.test.ts` exists for this one line.
 */
router.get(
  "/usuario/:id_usuario",
  requireSelfOrPermission("seguridad", "ver", "id_usuario"),
  getEvento_usuario,
);
router.get("/:id", requirePermission("eventos", "ver"), searchEvento);

router.delete("/:id", requirePermission("eventos", "archivar"), deleteEvento);
router.patch("/:id/desarchivar", requirePermission("eventos", "archivar"), desarchivarEvento);

export default router;
