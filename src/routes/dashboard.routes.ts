import { Router } from "express";
import { getDashboard } from "../controllers/dashboard.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

/**
 * The home screen's data, and the only read on this API that needed a gate
 * before any of the others.
 *
 * `authenticate` was the whole of it until now, which put every incident and
 * every pole — names, exact coordinates, owner, material, and the full revision
 * and resolution history of each — behind nothing but a valid session. Every
 * other open read at least pages at a hundred rows; this one has no `where`, no
 * `limit` and no projection, so one call is the entire asset register.
 *
 * It asks for `eventos.ver` rather than `postes.ver` because the incidents are
 * the sensitive half and the reason the screen exists; a role that may not see
 * incidents has no business receiving all of them aggregated. The three seeded
 * roles all hold it, so nothing a customer uses today changes. What changes is
 * that a role built in Seguridad with `eventos` denied now actually is.
 */
router.get("/", requirePermission("eventos", "ver"), getDashboard);

export default router;
