import { Router } from "express";
import { getAllBitacora, getBitacora } from "../controllers/bitacora.controller.js";
import { requireRole, requireSelfOrRole } from "../middleware/requireRole.js";

const router = Router();

// The audit log is administration-only in the interface (menuItems.ts lists
// Bitácora for role 1), but the API was open to any authenticated user. Beyond
// the obvious, it leaks the report builder's own private state: the names of
// other people's private reports, their authors, and the shape of every
// execution.
const ADMIN = 1;

router.get("/", requireRole(ADMIN), getAllBitacora);
// A user may review their own activity; anything else is administration.
router.get("/:id_usuario", requireSelfOrRole(ADMIN), getBitacora);

export default router;
