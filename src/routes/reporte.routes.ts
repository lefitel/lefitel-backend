import { Router } from "express";
import {
  putReporteGeneral,
  putReporteTramo,
  putReporteRecorrido,
} from "../controllers/reporte.controller.js";

const router = Router();

router.put("/general",   putReporteGeneral);
router.put("/tramo",     putReporteTramo);
router.put("/recorrido", putReporteRecorrido);

export default router;
