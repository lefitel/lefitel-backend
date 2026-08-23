import { Router } from "express";
import { getMisPermisos, getPermisos, putPermisos } from "../controllers/permiso.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

/**
 * What the caller may do — and **nothing calls this any more.** Declared dead
 * here rather than deleted, so it is not one more endpoint whose disuse only
 * this comment knows about.
 *
 * It asks for no permission of its own, which was correct while it was in use:
 * gating it would need a permission to find out which permissions you hold, and
 * it only ever reports the caller's own, never anyone else's. That is why it
 * sits in `READ_GATE_NOT_APPLICABLE` in `routeGuards.test.ts` with a reason
 * beside it.
 *
 * What replaced it: the permission matrix now travels in the same answer as the
 * account it belongs to — `GET /api/auth/me`, and both login doors — so the
 * frontend learns its role and its permissions in one round trip instead of two.
 * `SesionProvider.tsx` reads them from there and asks nothing else. Checked
 * across both repositories: outside this file, `permisos/mias` appears only in
 * that test's exception list and in `docs/`.
 *
 * It goes together with `GET /api/login` (`login.controller.ts`'s
 * `comprobarToken`), the other read the new frontend stopped calling, whose
 * retirement is already written down in the spec — one removal, one entry to
 * take out of that exception list, and the controller and its test with it.
 */
router.get("/mias", getMisPermisos);

// The whole matrix, and the screen that edits it.
router.get("/", requirePermission("roles", "ver"), getPermisos);
router.put("/:id_rol", requirePermission("roles", "editar"), putPermisos);

export default router;
