import { Router } from "express";
import {
  putReporteGeneral,
  putReporteTramo,
  putReporteRecorrido,
  putEstadoRed,
  putObsFrecuencia,
  putTiemposResumen,
} from "../controllers/reporte.controller.js";
import { getOpcionesReporte } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// The lists the three report screens fill their filters from. This router has
// no parametric route at all, so the ordering trap of §3.2 does not apply here
// — declared first anyway, so all three mounts read the same way.
router.get("/opciones", requirePermission("reportes", "ver"), getOpcionesReporte);

router.put("/general",         requirePermission("reportes", "ver"), putReporteGeneral);
router.put("/tramo",           requirePermission("reportes", "ver"), putReporteTramo);
router.put("/recorrido",       requirePermission("reportes", "ver"), putReporteRecorrido);
router.put("/estado-red",      requirePermission("reportes", "ver"), putEstadoRed);
router.put("/obs-frecuencia",  requirePermission("reportes", "ver"), putObsFrecuencia);
router.put("/tiempos-resumen", requirePermission("reportes", "ver"), putTiemposResumen);

export default router;
