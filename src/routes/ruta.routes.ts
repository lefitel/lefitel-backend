import { Router } from "express";
import { consultarRuta } from "../controllers/ruta.controller.js";
import { rutaLimiter } from "../middleware/limiters.js";

const router = Router();

/**
 * The road route between the points of a tramo.
 *
 * **POST for a read, like `/api/generator/query`.** Fifty coordinate pairs do
 * not belong in a query string, and putting them there would write every pole's
 * position into the access log of anything in the path.
 *
 * **No permission gate, and that is a decision rather than an omission** — it is
 * written down in `routeGuards.test.ts`'s exception list too. Two reasons. This
 * returns no Osefi data: it takes coordinates the caller already holds and hands
 * back a line that follows public roads, so there is nothing here to be allowed
 * or denied a sight of. And its four callers sit behind three different modules
 * — the pole detail (`postes.ver`), the incident detail (`eventos.ver`) and the
 * recorrido report (`reportes.ver`) — so any single permission chosen here would
 * break two of them for a role that legitimately lacks it. There is no checkbox
 * on the Seguridad screen that would mean "may see roads".
 *
 * `rutaLimiter` is its own bucket and not a share of `consultaLimiter`, which
 * is for heavy queries against our own database. This route reads no rows: what
 * it spends is the routing provider's quota. The full reasoning, including what
 * a per-user bucket cannot bound, is beside the limiter itself.
 */
router.post("/query", rutaLimiter, consultarRuta);

export default router;
