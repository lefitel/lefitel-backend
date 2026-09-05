import { Router } from "express";
import { createRevision } from "../controllers/revision.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Routes
//
// Recording an inspection is `editar`, not `crear`: the incident already exists
// and this is work done to it, the same call `POST /api/evento/:id/resolve`
// makes. `crear` is reserved for opening an incident that did not exist.
//
// It asked for `crear` until now, while every button that offers it asked the
// browser for `editar` — so a role holding `ver` + `editar` without `crear` saw
// the button, wrote the inspection, and got a 403 the interface reported as
// success. See AddRevisionSheet on the other side of that.
router.post("/", requirePermission("eventos", "editar"), createRevision);

// D1: reading the inspections of one incident is `GET /api/evento/:id/revisiones`
// now. It was `GET /api/revision/:id_evento` — an address where the parameter
// named the parent rather than the row, so `GET /api/revision/5` returned the
// inspections *of incident 5* and not inspection 5. This mount keeps its POST
// and nothing else.

// No PUT and no DELETE. Neither ever had a caller — not once in the history of
// `web` — and an inspection that cannot be corrected is a product decision
// nobody has taken, not a route that should sit here waiting to be wired up
// without one. See §7 of the API standard spec.

export default router;
