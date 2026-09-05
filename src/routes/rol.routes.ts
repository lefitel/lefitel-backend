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
// able to promote themselves.
//
// C5 closed `GET /`, which used to answer any session on the grounds that
// "every screen that shows a person needs the name of their role". That was not
// true: a role's name travels inside the user payload, which is what every such
// screen actually renders, and this list has two callers — the permissions
// panel and the picker in the create/edit user sheet. Both are about handing
// out authority, so both ask `roles.ver`. The server already demanded a `roles`
// permission on the other half of that same flow: creating a user, or changing
// one's role, is refused without `roles.editar`.
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
router.get("/", requirePermission("roles", "ver"), getRol);
router.delete("/:id", requirePermission("roles", "archivar"), conContrasena(), deleteRol);
router.patch(
  "/:id/desarchivar",
  requirePermission("roles", "archivar"),
  conContrasena(),
  desarchivarRol,
);

export default router;
