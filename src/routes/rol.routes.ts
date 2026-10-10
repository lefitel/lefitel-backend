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
// 🔴 **The plain gate on every write here, and no `sinVentana` — the scope
// Isaias cut on 2026-09-08.** From plan 4C's decision D6 until then, these four
// asked for the caller's password on *every* request; §4.1 of
// `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md` puts them back
// inside the ten-minute window.
//
// **Why these four and not the rest of D6.** A role is a label. The authority
// is in the two routes that hand it out — `PUT /api/permiso/:id_rol` writes the
// matrix and `PUT /api/usuario/:id/rol` says who wears which label — and both
// of those keep the password on every request. Renaming "Supervisor" or undoing
// its archive leaves a stolen cookie exactly as powerful as it already was, and
// it is visible and reversible from the same screen. That is the test §4.1 of
// the design applies, and it is what `POST /api/usuario/` fails: an account
// minted there keeps its **own** credentials, so it outlives the victim
// changing their password, `logout-all`, a factor reset and the console rescue.
//
// **Still a prompt, just not per request.** The gate is not off: outside the
// window every one of these answers 403, and the way through is the caller's
// own password or a factor proved in the last ten minutes — whichever the
// account has. What the window buys is that confirming once covers the batch of
// edits somebody sat down to make.

// Routes
router.post("/", requirePermission("roles", "crear"), requireStepUp(), createRol);
router.put("/:id", requirePermission("roles", "editar"), requireStepUp(), updateRol);
router.get("/", requirePermission("roles", "ver"), getRol);
router.delete("/:id", requirePermission("roles", "archivar"), requireStepUp(), deleteRol);
router.patch(
  "/:id/restore",
  requirePermission("roles", "archivar"),
  requireStepUp(),
  desarchivarRol,
);

export default router;
