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
import { requireRole, requireSelfOrRole } from "../middleware/requireRole.js";

const router = Router();

// Until now any authenticated user could reach all of these, which made the
// report builder's field-level restrictions decorative: a role 3 account cannot
// select `usuario.phone` in a report, but could read the whole staff directory
// — names, phones, birthdays — straight from `GET /usuario`.
//
// Roles: 1 administration, 2 supervision, 3 operations/client.
const ADMIN = 1;
const STAFF = [1, 2];

// Administration only: creating, archiving, and looking users up by username.
router.post("/", requireRole(ADMIN), createUsuario);
router.delete("/:id", requireRole(ADMIN), deleteUsuario);
router.patch("/:id/desarchivar", requireRole(ADMIN), desarchivarUsuario);
router.get("/user/:user", requireRole(ADMIN), searchUsuario_user);

// The full directory backs the security and bitácora screens, both staff-only.
router.get("/", requireRole(...STAFF), getUsuario);

// Own record or administration: the profile page reads and edits the current
// user through these same endpoints, so locking them to admins would break it.
router.get("/:id", requireSelfOrRole(ADMIN), searchUsuario);
router.put("/:id", requireSelfOrRole(ADMIN), updateUsuario);
router.put("/username/:id", requireSelfOrRole(ADMIN), updateUserName);
router.put("/userpass/:id", requireSelfOrRole(ADMIN), updateUserPass);

export default router;
