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
// 🔴 **This write takes the ten-minute window like every other gated route —
// decision of 2026-10-10 (Isaias).** Decision D6 of plan 4C (2026-09-02) had
// put it on the password for every request, and it stayed there when Isaias cut
// D6's scope on 2026-09-08; the 2026-10-10 decision removed that exception.
//
// **Accepted cost, stated to him twice.** This route is where the authority
// is: it decides what a role *means*. Inside the window, somebody holding a
// hijacked session can rewrite the permission matrix and grant themselves the
// module — it is the sharpest case of the paths the decision accepted.
//
// There are two windows, ten minutes wide each: `mfa_satisfied_at`, bought by
// proving a factor, and `password_confirmed_at`, bought by a correct password
// on an account that has no factor to prove. The first serves accounts with a
// factor, the second the ones without; neither stands in for the other.
//
// One cost worth knowing: the 409 for editing your *own* role, and the 400 for
// a save with nothing in it, arrive after the gate was passed, because the gate
// runs before the controller.
router.get("/", requirePermission("roles", "ver"), getPermisos);
router.put(
  "/:id_rol",
  requirePermission("roles", "editar"),
  requireStepUp(),
  putPermisos,
);

export default router;
