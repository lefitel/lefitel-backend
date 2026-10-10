import { Router } from "express";
import { getPermisos, putPermisos } from "../controllers/permiso.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireStepUp } from "../middleware/requireStepUp.js";

const router = Router();

/**
 * `GET /mias` used to be here, and it is worth saying what it was.
 *
 * It answered with the caller's own role and permission matrix, and it asked
 * for no permission of its own — correctly, because gating it would have needed
 * a permission to find out which permissions you hold. It was declared dead in
 * this docstring on 23 August and removed once nothing called it.
 *
 * What replaced it: the matrix now travels in the same answer as the account it
 * belongs to — `GET /api/auth/me`, and both login doors — so the frontend
 * learns its role and its permissions in one round trip instead of two.
 * `SesionProvider.tsx` reads them from there and asks nothing else.
 *
 * It went out with `GET /api/login`, the other read the new frontend stopped
 * calling. `app.auth.test.ts` is where an authenticated request to each of the
 * two is pinned at 404 — authenticated on purpose, because `authenticate` is
 * mounted in front of this router in `app.ts`, so an anonymous request here
 * answers 401 whether the route exists or not and would prove nothing.
 */

// The whole matrix, and the screen that edits it. The gate sits behind the
// permission on the write — see `middleware/requireStepUp.ts` — so a stolen
// session cannot rewrite who may do what.
//
// 🔴 **`sinVentana: true` on the write here — decision D6 of plan 4C (Isaias,
// 2026-09-02), and one of the mounts that kept it when Isaias cut D6's scope
// on 2026-09-08.** The caller's password however they logged in, because the
// password is the one thing that lives neither in an Apple or Google keychain
// nor on a phone: it is what is missing from whoever has taken those.
//
// **This route is where the authority is.** §4.1 of
// `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md` put the four
// `rol` writes inside the ten-minute window on the grounds that a role is a
// label; this is the route that decides what a label *means*, so somebody who
// reached it with a stolen cookie would grant themselves the module. It stays
// out of the window for the same reason `POST /api/usuario/` does.
//
// **And it ignores both windows.** There are two of them now, ten minutes
// wide each: `mfa_satisfied_at`, bought by proving a factor, and
// `password_confirmed_at`, bought by a correct password on an account that has
// no factor to prove — the column this whole reauthentication arc exists to
// add. `sinVentana` means this route honours neither: the password, on every
// single request. Five wrong ones in a quarter of an hour shut the shared
// confirmation budget. Correct ones cost nothing. That is the property people
// will be surprised by, so it is written here rather than discovered.
//
// One cost worth knowing: the 409 for editing your *own* role, and the 400 for
// a save with nothing in it, both now arrive after the password was typed,
// because the gate runs before the controller.
router.get("/", requirePermission("roles", "ver"), getPermisos);
router.put(
  "/:id_rol",
  requirePermission("roles", "editar"),
  requireStepUp({ sinVentana: true }),
  putPermisos,
);

export default router;
