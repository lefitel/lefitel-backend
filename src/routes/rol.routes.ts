import { Router } from "express";
import {
  createRol,
  deleteRol,
  desarchivarRol,
  exigirNombreDeRol,
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
// 🔴 **The plain gate on every write here, as on every gated route.** From plan
// 4C's decision D6 until 2026-09-08 these four asked for the caller's password
// on *every* request; §4.1 of
// `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md` put them inside
// the ten-minute window, and the decision of 2026-10-10 put the rest of the
// gated routes there too, so these four are no longer the exception.
//
// **A role is a label, and that is why these four were first.** The authority
// is in the two routes that hand it out — `PUT /api/permiso/:id_rol` writes the
// matrix and `PUT /api/usuario/:id/rol` says who wears which label. Those two
// now take the window as well; inside it a hijacked session can rewrite the
// matrix or assign roles (accepted cost, see the design's Revisión 4). Renaming
// "Supervisor" or undoing its archive is visible and reversible from the same
// screen.
//
// **Still a prompt, just not per request.** The gate is not off: outside the
// window every one of these answers 403, and the way through is the caller's
// own password or a factor proved in the last ten minutes — whichever the
// account has. What the window buys is that confirming once covers the batch of
// edits somebody sat down to make.

// Routes
// The name is checked between the permission and the gate, so that a request
// that could never work is refused before anybody is asked for a password.
router.post("/", requirePermission("roles", "crear"), exigirNombreDeRol(true), requireStepUp(), createRol);
router.put("/:id", requirePermission("roles", "editar"), exigirNombreDeRol(false), requireStepUp(), updateRol);
router.get("/", requirePermission("roles", "ver"), getRol);
router.delete("/:id", requirePermission("roles", "archivar"), requireStepUp(), deleteRol);
router.patch(
  "/:id/restore",
  requirePermission("roles", "archivar"),
  requireStepUp(),
  desarchivarRol,
);

export default router;
