import { Router } from "express";
import { getAllBitacora, getBitacora } from "../controllers/bitacora.controller.js";
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";

const router = Router();

// The audit log is administration-only in the interface (menuItems.ts lists
// Bitácora for role 1), but the API was open to any authenticated user. Beyond
// the obvious, it leaks the report builder's own private state: the names of
// other people's private reports, their authors, and the shape of every
// execution.
router.get("/", requirePermission("bitacora", "ver"), getAllBitacora);
// A user may review their own activity; anything else needs the module.
//
// The parameter is named explicitly because it is `:id_usuario` here, not `:id`.
// The previous middleware read "id" unconditionally, so this comparison was
// always against undefined and this route was administration-only in practice,
// whatever the line above it claimed.
router.get("/:id_usuario", requireSelfOrPermission("bitacora", "ver", "id_usuario"), getBitacora);

export default router;
