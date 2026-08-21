import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  getCatalogo,
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

const router = Router();

/**
 * Running a report is the only endpoint here that can hold a database
 * connection for seconds at a time, so it gets its own budget. Listing and
 * saving are cheap and share the global one.
 */
const consultaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  // Keyed on the user, not the IP. Behind a reverse proxy every request shares
  // the proxy's address, so an IP-keyed budget of 30 would be 30 for the entire
  // installation, and one person paging through a long report would lock
  // everyone else out.
  //
  // The fallback runs the address through ipKeyGenerator, which folds IPv6 into
  // its /56 block. A raw address let one holder of an IPv6 prefix walk through
  // billions of distinct keys and spend the budget as many times over.
  // Namespaced so a user id can never collide with an address.
  keyGenerator: (req) =>
    req.user?.id != null ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`,
  message: { message: "Demasiadas consultas seguidas. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Exporting reads the whole report and, for a spreadsheet, thousands of
 * photographs from disk. Ten a minute is generous for a person clicking a
 * button and low enough that a script cannot use it to exhaust the server.
 */
const exportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (req) =>
    req.user?.id != null ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`,
  message: { message: "Demasiadas exportaciones seguidas. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});

// The module used to gate itself in one line for all three roles. Now each
// route asks for what it actually does, so an administrator can hand out
// running reports without handing out saving them. The catalog is still
// trimmed per role on top of this, and a saved report is still only reachable
// by its owner — that is ownership, not a permission.
router.get("/catalogo", requirePermission("generador", "ver"), getCatalogo);
router.post("/consulta", requirePermission("generador", "ver"), consultaLimiter, postConsulta);
// Building a file costs far more than answering a query, and only one runs at a
// time, so its budget is a fraction of the query one.
router.post("/exportar", requirePermission("generador", "ver"), exportLimiter, postExportar);

router.get("/reportes", requirePermission("generador", "ver"), getReportes);
router.get("/reportes/:id", requirePermission("generador", "ver"), getReporte);
router.post("/reportes", requirePermission("generador", "crear"), postReporte);
router.put("/reportes/:id", requirePermission("generador", "editar"), putReporte);
router.delete("/reportes/:id", requirePermission("generador", "archivar"), deleteReporte);
router.post("/reportes/:id/duplicar", requirePermission("generador", "crear"), postDuplicar);

export default router;
