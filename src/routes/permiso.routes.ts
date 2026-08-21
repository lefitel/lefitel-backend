import { Router } from "express";
import { getMisPermisos, getPermisos, putPermisos } from "../controllers/permiso.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// What the caller may do. Every session needs it — it is what the interface
// draws itself from — so it asks for no permission of its own; it only ever
// reports the caller's own, never anyone else's.
router.get("/mias", getMisPermisos);

// The whole matrix, and the screen that edits it.
router.get("/", requirePermission("roles", "ver"), getPermisos);
router.put("/:id_rol", requirePermission("roles", "editar"), putPermisos);

export default router;
