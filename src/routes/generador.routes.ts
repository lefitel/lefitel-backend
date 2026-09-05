import { Router } from "express";
import {
  getCatalogo,
  postConteo,
  postConsulta,
  postExportar,
  getReportes,
  getReporte,
  postReporte,
  putReporte,
  deleteReporte,
  postDuplicar,
} from "../controllers/generador.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
// Every budget this router mounts lives in `middleware/limiters.ts`, with its
// number and its reason. Two of them are **shared with other routers by
// decision**, not merely reused: `exportLimiter` with the three list downloads,
// because what it rations is the one slot in the process that assembles a
// document; and `consultaLimiter` with the six fixed reports under
// `/api/reporte`, because what it rations is the database's time. That file
// says what the sharing costs, and it is not nothing: this router's auto-run
// and its paging spend the same thirty a minute the report screens use.
import {
  consultaLimiter,
  conteoLimiter,
  exportLimiter,
  writeLimiter,
} from "../middleware/limiters.js";

const router = Router();

// The module used to gate itself in one line for all three roles. Now each
// route asks for what it actually does, so an administrator can hand out
// running reports without handing out saving them. The catalog is still
// trimmed per role on top of this, and a saved report is still only reachable
// by its owner — that is ownership, not a permission.
//
// Each budget goes **after** its permission gate, so a refusal spends nothing.
router.get("/catalogo", requirePermission("generador", "ver"), getCatalogo);
// Running a report is the only endpoint here that can hold a database
// connection for seconds at a time, so it gets the tightest budget.
router.post("/consulta", requirePermission("generador", "ver"), consultaLimiter, postConsulta);
router.post("/conteo", requirePermission("generador", "ver"), conteoLimiter, postConteo);
// Building a file costs far more than answering a query, and only one runs at a
// time, so its budget is a fraction of the query one.
router.post("/exportar", requirePermission("generador", "ver"), exportLimiter, postExportar);

router.get("/reportes", requirePermission("generador", "ver"), getReportes);
router.get("/reportes/:id", requirePermission("generador", "ver"), getReporte);
router.post("/reportes", requirePermission("generador", "crear"), writeLimiter, postReporte);
router.put("/reportes/:id", requirePermission("generador", "editar"), writeLimiter, putReporte);
router.delete(
  "/reportes/:id", requirePermission("generador", "archivar"), writeLimiter, deleteReporte,
);
router.post(
  "/reportes/:id/duplicar", requirePermission("generador", "crear"), writeLimiter, postDuplicar,
);

export default router;
