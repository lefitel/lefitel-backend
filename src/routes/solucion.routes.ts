import { Router } from "express";
import { getSolucion_evento } from "../controllers/solucion.controller.js";

const router = Router();

// The rest of this CRUD is gone, and this is the only route left. See §7 of the
// API standard spec for the whole argument; the short version is that
// `POST /api/evento/:id/resolver` writes the repair and flips the event's state
// in one transaction, and `reabrir` undoes both. The loose create and delete
// could only ever do half of that — one left an event fixed and still listed as
// open, the other left it resolved with no record of how.
//
// This route stays because it has a live consumer, and losing it would be
// silent: both callers in `web` wrap it in `.catch(() => null)`, so a 404 here
// would paint every resolved event as pending with nothing in the console. The
// mount itself goes away in D1, when this becomes `GET /api/evento/:id/solucion`.
router.get("/evento/:id_evento", getSolucion_evento);

export default router;
