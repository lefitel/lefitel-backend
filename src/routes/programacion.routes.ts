import { Router } from "express";
import {
  deleteProgramacion,
  getDestinatariosPosibles,
  getEjecucionesDeProgramacion,
  getProgramaciones,
  postEjecutarProgramacion,
  postProgramacion,
  putProgramacion,
} from "../controllers/programacion.controller.js";
import { exportLimiter, writeLimiter } from "../middleware/limiters.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireStepUp } from "../middleware/requireStepUp.js";

// Scheduled reports. Mounted at `/api/generator/schedules`, behind
// `authenticate` like the rest of the generator.
//
// The addresses are in English — `schedules`, `recipients`, `runs` — by the
// API standard's §3.4: business nouns of the network stay in Spanish and
// everything else does not, and a schedule is vocabulary of the application,
// like `dashboard`. The code behind them keeps the words the screen uses.
// Design: docs/specs/2026-10-10-informes-programados-design.md §3.6, §3.8.
//
// **Reading asks `generador.ver`; everything that writes asks
// `generador.programar`.** Being able to build a report is not the authority
// to have it mailed every morning to ten addresses, some of them outside the
// company — which is why this is a permission of its own, granted at first to
// the Administrador alone.
//
// **Creating and changing a schedule sit inside the re-authentication
// window** (`requireStepUp()` with no options: one confirmation, good for ten
// minutes). A schedule is a standing instruction to send data out, and a
// stolen session that could add `attacker@elsewhere` to a daily report would
// keep receiving it long after the session ended. Removing one and sending
// one now ask no confirmation: the first stops data leaving, and the second
// sends only to recipients somebody already confirmed.
const router = Router();

router.get("/", requirePermission("generador", "ver"), getProgramaciones);
router.get("/recipients", requirePermission("generador", "programar"), getDestinatariosPosibles);
router.get("/:id/runs", requirePermission("generador", "ver"), getEjecucionesDeProgramacion);

router.post("/", requirePermission("generador", "programar"), writeLimiter, requireStepUp(), postProgramacion);
router.put("/:id", requirePermission("generador", "programar"), writeLimiter, requireStepUp(), putProgramacion);
router.delete("/:id", requirePermission("generador", "programar"), writeLimiter, deleteProgramacion);
// The export limiter, not the write one: this builds a file.
router.post("/:id/run", requirePermission("generador", "programar"), exportLimiter, postEjecutarProgramacion);

export default router;
