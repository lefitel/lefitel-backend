import { Router, type Request, type Response, type NextFunction } from "express";
import {
  getReporteGeneral,
  getReporteTramo,
  getReporteRecorrido,
  getEstadoRed,
  getObsFrecuencia,
  getTiemposResumen,
} from "../controllers/reporte.controller.js";
import { getOpcionesReporte } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { consultaLimiter } from "../middleware/limiters.js";

const router = Router();

// The lists the three report screens fill their filters from. This router has
// no parametric route at all, so the ordering trap of §3.2 does not apply here
// — declared first anyway, so all three mounts read the same way.
router.get("/options", requirePermission("reportes", "ver"), getOpcionesReporte);

/**
 * Says out loud that a report must not be stored anywhere.
 *
 * Nothing in this API sets a caching header, and with `PUT` that was fine: no
 * cache stores a `PUT`. As `GET` these become storable by default, and what
 * decides whether they are stored is heuristics — Express adds a weak ETag and
 * nothing else, so today a browser revalidates and at worst gets a 304, which is
 * correct behaviour. That is a property of the browsers in use rather than
 * something written down, and it stops holding the day a CDN or a caching proxy
 * is put in front of the API.
 *
 * These six answer a company's incident history, filtered per request and gated
 * on a permission. `no-store` is one header and it turns "probably nobody keeps
 * a copy" into "nobody may".
 */
const sinCache = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

// `GET` and not `PUT`, which is §3.1 of the API standard: these six read, they
// write nothing at all — no bitácora line, no saved view, no counter — and their
// whole filter is five scalars that fit in a URL. A `PUT` that changes nothing is
// a lie told to every cache, proxy and retry in the path.
//
// **What the change costs, and what bounds it.** `requireSameOrigin` in
// `app.ts` only guards the four writing verbs, so as `GET` these six leave it:
// they lose the `Origin` check and the client header at once. The session
// cookie is `SameSite=Lax`, which rides a top-level navigation and nothing else
// — not an `<img>`, not a frame, not a `fetch` — so what a page on another site
// can do is make somebody's browser run one of these per visible navigation,
// with their session, and never read the answer (CORS sees to that). Somebody
// else's CPU, one query at a time: not a leak, and not a loop. No budget closes
// that; it is written here as the exposure it is.
//
// What the budget does bound is the caller who *is* logged in — a script with a
// live session, or a stolen cookie — asking these six in a loop.
// `consultaLimiter` is the generator's thirty a minute: one bucket for the seven
// routes that run a heavy query, by decision (B3, 2026-09-04) and for the reason
// its file gives. It goes **after** the permission gate, so a refusal spends
// nothing of the budget. What a refused or a rate-limited request still costs
// is `authenticate`, which the budget has to sit behind in order to key on the
// user: a session read, a user read and, once per touch window, the session
// slide it writes along with its `Set-Cookie`. A script sitting on refusals
// keeps its session alive. `/options` stays outside it on purpose: it is asked once
// per visit to a report tab, and metering it would make switching tabs spend
// the report budget.
const conPresupuesto = [sinCache, requirePermission("reportes", "ver"), consultaLimiter];
router.get("/general",         conPresupuesto, getReporteGeneral);
router.get("/tramo",           conPresupuesto, getReporteTramo);
router.get("/recorrido",       conPresupuesto, getReporteRecorrido);
router.get("/estado-red",      conPresupuesto, getEstadoRed);
router.get("/frecuencia-obs",  conPresupuesto, getObsFrecuencia);
router.get("/resumen-tiempos", conPresupuesto, getTiemposResumen);

export default router;
