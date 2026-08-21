import { Router } from "express";
import {
  putReporteGeneral,
  putReporteTramo,
  putReporteRecorrido,
  putEstadoRed,
  putObsFrecuencia,
  putTiemposResumen,
} from "../controllers/reporte.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

router.put("/general",         requirePermission("reportes", "ver"), putReporteGeneral);
router.put("/tramo",           requirePermission("reportes", "ver"), putReporteTramo);
router.put("/recorrido",       requirePermission("reportes", "ver"), putReporteRecorrido);
router.put("/estado-red",      requirePermission("reportes", "ver"), putEstadoRed);
router.put("/obs-frecuencia",  requirePermission("reportes", "ver"), putObsFrecuencia);
router.put("/tiempos-resumen", requirePermission("reportes", "ver"), putTiemposResumen);

export default router;
