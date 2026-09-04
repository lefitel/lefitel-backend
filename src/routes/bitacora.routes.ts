import { Router } from "express";
import { getAllBitacora, getAutoresBitacora, getBitacora } from "../controllers/bitacora.controller.js";
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";

const router = Router();

// The audit log is administration-only in the interface (menuItems.ts lists
// Bitácora for role 1), but the API was open to any authenticated user. Beyond
// the obvious, it leaks the report builder's own private state: the names of
// other people's private reports, their authors, and the shape of every
// execution.
router.get("/", requirePermission("bitacora", "ver"), getAllBitacora);
// Before `/:id_usuario`, and this is the ordering rule of the standard's 3.2
// rather than a preference. Express matches in declaration order, so declared
// after, `/autores` never runs: the parametric route takes it, queries the log
// for `id_usuario = "autores"`, and Postgres refuses the comparison — a 500 on a
// route that looks correct in the file. `routeOrder.test.ts` holds every router
// in the API to this generically.
router.get("/autores", requirePermission("bitacora", "ver"), getAutoresBitacora);
// A user may review their own activity; anything else needs the module.
//
// The parameter is named explicitly because it is `:id_usuario` here, not `:id`.
// The previous middleware read "id" unconditionally, so this comparison was
// always against undefined and this route was administration-only in practice,
// whatever the line above it claimed.
router.get("/:id_usuario", requireSelfOrPermission("bitacora", "ver", "id_usuario"), getBitacora);

export default router;
