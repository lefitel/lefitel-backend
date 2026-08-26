import { Router } from "express";
import {
  createRol,
  deleteRol,
  desarchivarRol,
  getRol,
  updateRol,
} from "../controllers/rol.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireStepUp } from "../middleware/requireStepUp.js";

const router = Router();

// Its own module, not part of Seguridad. Managing user accounts and handing out
// authority are different powers: whoever can edit a user must not thereby be
// able to promote themselves. `GET /` stays open to any session because every
// screen that shows a person needs the name of their role.
//
// `requireStepUp()` sits behind the permission on every write, never in
// front — see `middleware/requireStepUp.ts`. Reads carry neither.

// Routes
router.post("/", requirePermission("roles", "crear"), requireStepUp(), createRol);
router.put("/:id", requirePermission("roles", "editar"), requireStepUp(), updateRol);
router.get("/", getRol);
router.delete("/:id", requirePermission("roles", "archivar"), requireStepUp(), deleteRol);
router.patch(
  "/:id/desarchivar",
  requirePermission("roles", "archivar"),
  requireStepUp(),
  desarchivarRol,
);

export default router;
