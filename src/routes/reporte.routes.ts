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

const router = Router();

// The lists the three report screens fill their filters from. This router has
// no parametric route at all, so the ordering trap of §3.2 does not apply here
// — declared first anyway, so all three mounts read the same way.
router.get("/opciones", requirePermission("reportes", "ver"), getOpcionesReporte);

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
// **What the change costs, and is not paid here.** `requireSameOrigin` in
// `app.ts` only guards the four writing verbs, so as `GET` these six leave it:
// they lose the `Origin` check and the client header at once, and the session
// cookie is `SameSite=Lax`, which a top-level navigation carries. A page on
// another site can therefore make somebody's browser run the most expensive
// query in the product with their session. It cannot read the answer — CORS sees
// to that — so this is somebody else's CPU, not a leak. There is no rate limiter
// on this router at all. The fix belongs to B3, whose bucket decision is Isaias's
// and still open; it is written up in §9 of the spec rather than invented here.
router.get("/general",         sinCache, requirePermission("reportes", "ver"), getReporteGeneral);
router.get("/tramo",           sinCache, requirePermission("reportes", "ver"), getReporteTramo);
router.get("/recorrido",       sinCache, requirePermission("reportes", "ver"), getReporteRecorrido);
router.get("/estado-red",      sinCache, requirePermission("reportes", "ver"), getEstadoRed);
router.get("/obs-frecuencia",  sinCache, requirePermission("reportes", "ver"), getObsFrecuencia);
router.get("/tiempos-resumen", sinCache, requirePermission("reportes", "ver"), getTiemposResumen);

export default router;
