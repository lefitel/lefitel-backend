import { Router } from "express";
import {
  createRol,
  deleteRol,
  getRol,
  updateRol,
} from "../controllers/rol.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

// Its own module, not part of Seguridad. Managing user accounts and handing out
// authority are different powers: whoever can edit a user must not thereby be
// able to promote themselves. `GET /` stays open to any session because every
// screen that shows a person needs the name of their role.

// Routes
router.post("/", requirePermission("roles", "crear"), createRol);
router.put("/:id", requirePermission("roles", "editar"), updateRol);
router.get("/", getRol);
router.delete("/:id", requirePermission("roles", "archivar"), deleteRol);

export default router;
