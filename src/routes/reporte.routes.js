import { Router } from "express";
import {
  putReporteGeneral,
  putReporteTramo,
} from "../controllers/reporte.controller.js";

const router = Router();

// Routes
router.put("/general", putReporteGeneral);
router.put("/tramo", putReporteTramo);

export default router;
