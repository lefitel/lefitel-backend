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
  requiresOwnPassword,
  updateUserName,
  updateUserPass,
  updateUsuario,
} from "../controllers/usuario.controller.js";
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";
import { requireStepUp } from "../middleware/requireStepUp.js";
import { passwordConfirmLimiter } from "../middleware/loginLimiters.js";

const router = Router();

/**
 * Confirming your own password costs the same on these two routes, out of one
 * bucket, and only when it was wrong.
 *
 * Both `updateUserName` and `updateUserPass` compare a password now, and an
 * authenticated endpoint that compares an unlimited number of them is a
 * password oracle for whoever already stole a session — the sentence
 * `passwordConfirmLimiter` exists for. Without this, closing the client-side
 * hole on the rename would have been a net loss: an attacker holding a stolen
 * session would simply guess against a route that counts nothing.
 *
 * These were the only two routes on that bucket, until `requireStepUp`
 * (`middleware/requireStepUp.ts`) started calling `passwordConfirmLimiter`
 * directly for its own password fallback — mounted ahead of this very
 * function on both of these routes, and on several more besides. `POST
 * /api/auth/confirm-password` was a third caller of a different kind, and it
 * is retired — see `auth.routes.ts`.
 *
 * **`updateUserPass` needed it more, and had it least.** It has compared
 * `oldPass` since long before this plan, with no bucket of any kind on the
 * route — and the oracle there is cleaner than a rename's, because a caller can
 * send a guess with a new password that fails the policy and read the answer
 * off the difference between 401 (wrong) and 400 (right, and the new one is too
 * short). Unlimited, from one session, counting nothing anywhere. Mounting this
 * closes a hole that predates the change it accompanies.
 *
 * The lockout cannot serve as that limit. A wrong password on either route
 * deliberately does not move `failed_attempts` — see the blocks in the two
 * handlers — because mistyping your own password while renaming or
 * re-passwording yourself must not be able to shut you out of the ERP.
 *
 * **The same bucket, not one per route**, because it is the same secret being
 * guessed at by the same account. Separate buckets keyed the same way would
 * hand out ten attempts a quarter of an hour to anybody willing to alternate the
 * two, which is what counting several doors onto one room separately gets you.
 *
 * **What keeps a stranger from emptying somebody else's allowance is this
 * function, not where it is mounted.** Charged only when the request actually
 * confirms a password, decided by `requiresOwnPassword` — the very function both
 * handlers branch on, so the limit and the checks cannot drift apart. Three
 * things follow. An administrator renaming or resetting *other people's*
 * accounts sends no password and pays nothing: billing those would answer 429 to
 * the sixth piece of legitimate work in a quarter of an hour. Nobody can dodge
 * the budget by mis-spelling the password field, because what is measured is
 * *whose* account is being changed, not what the body happens to carry. And a
 * caller reaching for an account that is not theirs charges nothing at all — not
 * their own bucket and not the target's — because the only bucket this could
 * touch is the caller's own and it is not touched.
 *
 * **Mounted after the permission guard, and that order is on purpose even though
 * nothing observable depends on it today.** The two conditions coincide:
 * `requiresOwnPassword` is true exactly when the target is the caller, and
 * `requireSelfOrPermission` always lets the caller through for their own record,
 * so no request exists that the guard refuses and this would have charged. The
 * order is asserted structurally in `app.auth.test.ts` rather than through a
 * response, because that is the honest way to pin a property no response can
 * show — and it is worth pinning: the day the charge condition widens (an
 * administrator sending `oldPass` for somebody else, say, which the MFA plan's
 * step-up could easily want), this order becomes the only thing between a
 * stranger and a stranger's allowance. This comment used to claim the protection
 * came from the order, and a test claimed to hold it while passing with the two
 * swapped.
 */
function chargeConfirmBudgetOnSelfChange(req: Request, res: Response, next: NextFunction) {
  if (!requiresOwnPassword(req)) return next();
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
// `requireStepUp()` sits behind every permission check below, never in
// front: somebody without the permission gets 403 from the permission,
// spends no bcrypt comparison, and learns nothing about the route existing.
// See `middleware/requireStepUp.ts` for what it asks of the caller.
router.post("/", requirePermission("seguridad", "crear"), requireStepUp(), createUsuario);
router.delete("/:id", requirePermission("seguridad", "archivar"), requireStepUp(), deleteUsuario);
router.patch(
  "/:id/desarchivar",
  requirePermission("seguridad", "archivar"),
  requireStepUp(),
  desarchivarUsuario,
);
// `editar` and not `archivar`: lifting a lockout is the same kind of act as
// resetting a password, which is the other way out of one. PATCH like its
// neighbour above — both flip a state on a row that already exists.
//
// **This one used to be the deliberate exception, and the exception went
// stale.** The argument written here was that step-up "adds a step to the
// recovery path without closing anything", because whoever holds
// `seguridad.editar` and a live session "can do far greater damage through the
// routes above, which do require it". That was true, and it was true only for
// as long as the routes above accept exactly what this one accepts. They do
// today: nobody has a factor, so the gate's third branch lets a request with no
// `stepup_password` through on all of them alike.
//
// Plan 4B is what ends that. From the first registered factor, every route
// above answers 403 to a session that has not proved one — and this route, left
// ungated, would go on answering 200. That is the shape the argument cannot
// survive: a stolen administrator cookie, refused everywhere else on this
// router, still able to clear `failed_attempts` and `locked_until` on any
// account it chooses. Those two columns are the login lockout, and they are the
// only brake against guessing a password that lives in the database: the
// rate limiters that also count per account (`loginLimiters.ts`) keep their
// counters in a `MemoryStore`, so they reset with the process and never span
// more than their own window. See `desbloquearUsuario` in
// `usuario.controller.ts`, which writes both to zero and NULL and files a
// `critical` line saying what it undid.
//
// The recovery path still works, and this is what it costs the administrator in
// a hurry: nothing at all while no account has a factor, and one proof of their
// own factor afterwards — the same one the neighbouring routes will ask them
// for. `requireStepUp()` with no options, like every other administrative
// mount: an `onboarding` session is refused outright rather than falling to
// the password fallback.
router.patch(
  "/:id/desbloquear",
  requirePermission("seguridad", "editar"),
  requireStepUp(),
  desbloquearUsuario,
);
router.get("/user/:user", requirePermission("seguridad", "ver"), searchUsuario_user);

// The full directory backs the security and bitácora screens.
router.get("/", requirePermission("seguridad", "ver"), getUsuario);

// Own record, or the permission. The profile page reads and edits whoever is
// logged in through these same endpoints, so requiring the module here would
// stop people changing their own password. Ownership is not a role permission
// and has no checkbox — see requirePermission.ts.
router.get("/:id", requireSelfOrPermission("seguridad", "ver"), searchUsuario);
router.put("/:id", requireSelfOrPermission("seguridad", "editar"), requireStepUp(), updateUsuario);
router.put(
  "/username/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp(),
  chargeConfirmBudgetOnSelfChange,
  updateUserName,
);
router.put(
  "/userpass/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp(),
  chargeConfirmBudgetOnSelfChange,
  updateUserPass,
);

export default router;
