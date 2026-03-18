import { Router } from "express";
import {
  putReporteGeneral,
  putReporteTramo,
  putReporteRecorrido,
  putEstadoRed,
  putObsFrecuencia,
  putTiemposResumen,
} from "../controllers/reporte.controller.js";

const router = Router();

router.put("/general",         putReporteGeneral);
router.put("/tramo",           putReporteTramo);
router.put("/recorrido",       putReporteRecorrido);
router.put("/estado-red",      putEstadoRed);
router.put("/obs-frecuencia",  putObsFrecuencia);
router.put("/tiempos-resumen", putTiemposResumen);

export default router;
