import { Router } from "express";
import {
  createUsuario,
  deleteUsuario,
  desarchivarUsuario,
  getUsuario,
  searchUsuario,
  searchUsuario_user,
  updateUserName,
  updateUserPass,
  updateUsuario,
} from "../controllers/usuario.controller.js";
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";

const router = Router();

// Until now any authenticated user could reach all of these, which made the
// report builder's field-level restrictions decorative: a role 3 account cannot
// select `usuario.phone` in a report, but could read the whole staff directory
// — names, phones, birthdays — straight from `GET /usuario`.
//
// Everything here belongs to the Seguridad module, and which action a route
// needs is the point: creating an account and reading one are not the same
// permission even though they live behind the same screen.
router.post("/", requirePermission("seguridad", "crear"), createUsuario);
router.delete("/:id", requirePermission("seguridad", "archivar"), deleteUsuario);
router.patch("/:id/desarchivar", requirePermission("seguridad", "archivar"), desarchivarUsuario);
router.get("/user/:user", requirePermission("seguridad", "ver"), searchUsuario_user);

// The full directory backs the security and bitácora screens.
router.get("/", requirePermission("seguridad", "ver"), getUsuario);

// Own record, or the permission. The profile page reads and edits whoever is
// logged in through these same endpoints, so requiring the module here would
// stop people changing their own password. Ownership is not a role permission
// and has no checkbox — see requirePermission.ts.
router.get("/:id", requireSelfOrPermission("seguridad", "ver"), searchUsuario);
router.put("/:id", requireSelfOrPermission("seguridad", "editar"), updateUsuario);
router.put("/username/:id", requireSelfOrPermission("seguridad", "editar"), updateUserName);
router.put("/userpass/:id", requireSelfOrPermission("seguridad", "editar"), updateUserPass);

export default router;
