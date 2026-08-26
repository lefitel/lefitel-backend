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

// The whole matrix, and the screen that edits it. `requireStepUp()` sits
// behind the permission on the write — see `middleware/requireStepUp.ts` —
// so a stolen session cannot rewrite who may do what without also proving a
// factor, or the caller's own password while nobody has registered one yet.
router.get("/", requirePermission("roles", "ver"), getPermisos);
router.put("/:id_rol", requirePermission("roles", "editar"), requireStepUp(), putPermisos);

export default router;
