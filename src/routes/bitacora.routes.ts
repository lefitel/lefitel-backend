import { Router } from "express";
import { getAllBitacora, getAutoresBitacora } from "../controllers/bitacora.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// The audit log is administration-only in the interface (menuItems.ts lists
// Bitácora for role 1), but the API was open to any authenticated user. Beyond
// the obvious, it leaks the report builder's own private state: the names of
// other people's private reports, their authors, and the shape of every
// execution.
router.get("/", requirePermission("bitacora", "ver"), getAllBitacora);
// D1: `/authors` rather than `/autores`. A collection with no business noun in
// it goes in English and in the plural, like `/files` and `/orphans` — §3.4.
// This route was written after that table, which is why it was not in it.
//
// There is no longer a parametric sibling for it to be shadowed by: one
// person's audit trail moved to `GET /api/usuario/:id/bitacora` in the same
// change, because in a log about people `:id_usuario` does not identify the
// log. The ordering rule of §3.2 still holds generically and
// `routeOrder.test.ts` still enforces it; it simply has nothing to catch here
// now.
router.get("/authors", requirePermission("bitacora", "ver"), getAutoresBitacora);

export default router;
