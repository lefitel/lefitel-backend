import { Router } from "express";
import rateLimit from "express-rate-limit";
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

/**
 * Running a report is the only endpoint here that can hold a database
 * connection for seconds at a time, so it gets its own budget. Listing and
 * saving are cheap and share the global one.
 */
const consultaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  message: { message: "Demasiadas consultas seguidas. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Every role that can reach the module; the catalog itself is trimmed per role.
router.use(requireRole(1, 2, 3));

router.get("/catalogo", getCatalogo);
router.post("/consulta", consultaLimiter, postConsulta);

router.get("/reportes", getReportes);
router.get("/reportes/:id", getReporte);
router.post("/reportes", postReporte);
router.put("/reportes/:id", putReporte);
router.delete("/reportes/:id", deleteReporte);
router.post("/reportes/:id/duplicar", postDuplicar);

export default router;
