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
// The gate sits behind the permission on every write, never in front — see
// `middleware/requireStepUp.ts`. Reads carry neither.
//
// 🔴 **`exigeContrasena: true` on every write here — decision D6 of plan 4C
// (Isaias, 2026-09-02).** Permissions, roles and user accounts demand the
// caller's password however they logged in, because the password is the one
// thing that lives neither in an Apple or Google keychain nor on a phone: it
// is what is missing from whoever has taken those. Before 4C these mounts
// were content with a factor proved in the last ten minutes.
//
// **And it has no window.** The factor is asked once per ten minutes; the
// password, on every request this option is on — there is no "password proved
// recently" equivalent. Five wrong ones in a quarter of an hour shut the
// shared confirmation budget. Correct ones cost nothing. That is the property
// people will be surprised by, so it is written here rather than discovered.

const conContrasena = () => requireStepUp({ exigeContrasena: true });

// Routes
router.post("/", requirePermission("roles", "crear"), conContrasena(), createRol);
router.put("/:id", requirePermission("roles", "editar"), conContrasena(), updateRol);
router.get("/", getRol);
router.delete("/:id", requirePermission("roles", "archivar"), conContrasena(), deleteRol);
router.patch(
  "/:id/desarchivar",
  requirePermission("roles", "archivar"),
  conContrasena(),
  desarchivarRol,
);

export default router;
