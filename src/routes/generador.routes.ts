import { Router } from "express";
import {
  getCatalogo,
  postConsulta,
  getReportes,
  getReporte,
  postReporte,
  putReporte,
  deleteReporte,
  postDuplicar,
} from "../controllers/generador.controller.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

// Every role that can reach the module; the catalog itself is trimmed per role.
router.use(requireRole(1, 2, 3));

router.get("/catalogo", getCatalogo);
router.post("/consulta", postConsulta);

router.get("/reportes", getReportes);
router.get("/reportes/:id", getReporte);
router.post("/reportes", postReporte);
router.put("/reportes/:id", putReporte);
router.delete("/reportes/:id", deleteReporte);
router.post("/reportes/:id/duplicar", postDuplicar);

export default router;
