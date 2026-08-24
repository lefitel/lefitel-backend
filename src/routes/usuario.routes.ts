import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  createUsuario,
  deleteUsuario,
  desarchivarUsuario,
  desbloquearUsuario,
  getUsuario,
  searchUsuario,
  searchUsuario_user,
  renameRequiresOwnPassword,
  updateUserName,
  updateUserPass,
  updateUsuario,
} from "../controllers/usuario.controller.js";
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";
import { passwordConfirmLimiter } from "../middleware/loginLimiters.js";

const router = Router();

/**
 * Confirming your own password costs the same here as on
 * `POST /api/auth/confirm-password`, and out of the same bucket.
 *
 * `updateUserName` compares a password now, and an authenticated endpoint that
 * compares an unlimited number of them is a password oracle for whoever already
 * stole a session — the sentence `passwordConfirmLimiter` exists for. Without
 * this, closing the client-side hole would have been a net loss: an attacker
 * holding a stolen session would simply guess against this route, which counts
 * nothing, instead of against the confirmation endpoint, which counts five per
 * quarter of an hour.
 *
 * The lockout cannot serve as that limit. A wrong password here deliberately
 * does not move `failed_attempts` — see the block in `updateUserName` — because
 * mistyping while renaming yourself must not be able to shut you out of the
 * ERP.
 *
 * **The same bucket, not a second one**, because it is the same secret being
 * guessed at by the same account. Two buckets keyed the same way would hand out
 * ten attempts a quarter of an hour to anybody willing to alternate endpoints,
 * which is what counting two doors onto one room separately gets you.
 *
 * Charged only when the rename actually confirms a password, decided by
 * `renameRequiresOwnPassword` — the very function the handler branches on, so
 * the limit and the check cannot drift apart. Two things follow from that.
 * An administrator renaming other people's accounts sends no password and pays
 * nothing: billing those would answer 429 to the sixth piece of legitimate work
 * in a quarter of an hour. And nobody can dodge the budget by mis-spelling the
 * password field, because what is measured is *whose* account is being renamed,
 * not what the body happens to carry.
 *
 * After the permission guard, so a request that was never allowed through does
 * not spend anybody's attempts.
 */
function chargeConfirmBudgetOnSelfRename(req: Request, res: Response, next: NextFunction) {
  if (!renameRequiresOwnPassword(req)) return next();
  return passwordConfirmLimiter(req, res, next);
}

// Until now any authenticated user could reach all of these, which made the
// report builder's field-level restrictions decorative: a role 3 account cannot
// select `usuario.phone` in a report, but could read the whole staff directory
// — names, phones, birthdays — straight from `GET /usuario`.
//
// Everything here belongs to the Seguridad module, and which action a route
// needs is the point: creating an account and reading one are not the same
// permission even though they live behind the same screen.
router.post("/", requirePermission("seguridad", "crear"), createUsuario);
router.delete("/:id", requirePermission("seguridad", "archivar"), deleteUsuario);
router.patch("/:id/desarchivar", requirePermission("seguridad", "archivar"), desarchivarUsuario);
// `editar` and not `archivar`: lifting a lockout is the same kind of act as
// resetting a password, which is the other way out of one. PATCH like its
// neighbour above — both flip a state on a row that already exists.
router.patch("/:id/desbloquear", requirePermission("seguridad", "editar"), desbloquearUsuario);
router.get("/user/:user", requirePermission("seguridad", "ver"), searchUsuario_user);

// The full directory backs the security and bitácora screens.
router.get("/", requirePermission("seguridad", "ver"), getUsuario);

// Own record, or the permission. The profile page reads and edits whoever is
// logged in through these same endpoints, so requiring the module here would
// stop people changing their own password. Ownership is not a role permission
// and has no checkbox — see requirePermission.ts.
router.get("/:id", requireSelfOrPermission("seguridad", "ver"), searchUsuario);
router.put("/:id", requireSelfOrPermission("seguridad", "editar"), updateUsuario);
router.put(
  "/username/:id",
  requireSelfOrPermission("seguridad", "editar"),
  chargeConfirmBudgetOnSelfRename,
  updateUserName,
);
router.put("/userpass/:id", requireSelfOrPermission("seguridad", "editar"), updateUserPass);

export default router;
