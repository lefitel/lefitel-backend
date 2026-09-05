import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  createUsuario,
  deleteUsuario,
  desarchivarUsuario,
  desbloquearUsuario,
  exportarUsuarios,
  getUsuario,
  rescatarMfaDeUsuario,
  searchUsuario,
  searchUsuario_user,
  requiresOwnPassword,
  updateUserName,
  updateUserPass,
  updateUsuario,
} from "../controllers/usuario.controller.js";
// D1 (§3.2): two listings that are about a *person* now hang off that person.
// They were `GET /api/evento/usuario/:id_usuario` and `GET /api/bitacora/:id_usuario`,
// both under a parent that named the rows rather than the subject.
import { getEvento_usuario } from "../controllers/evento.controller.js";
import { getBitacora } from "../controllers/bitacora.controller.js";
import { requirePermission, requireSelfOrPermission } from "../middleware/requirePermission.js";
import { exportLimiter } from "../middleware/limiters.js";
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
 * accounts sends no `oldPass` and pays nothing **here** — since decision D6
 * they do send `stepup_password` to the gate ahead of this, which charges only
 * a wrong one; a right one is free, so legitimate administrative work still
 * costs nothing: billing it would answer 429 to the sixth piece of it in a
 * quarter of an hour. Nobody can dodge
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
// The gate sits behind every permission check below, never in front: somebody
// without the permission gets 403 from the permission, spends no bcrypt
// comparison, and learns nothing about the route existing. See
// `middleware/requireStepUp.ts` for what it asks of the caller.
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
//
// Thirteen mounts across this router, `rol.routes.ts` and `permiso.routes.ts`
// carry it; D6 added eleven — the plan counted nine and missed the three at the
// bottom of this file, which are the ones that rename an account and change its
// password: precisely the primitives a stolen cookie would reach for. The other
// two, `desbloquear` and `mfa/reset`, had it since hallazgo F8.
router.post(
  "/",
  requirePermission("seguridad", "crear"),
  requireStepUp({ exigeContrasena: true }),
  createUsuario,
);
router.delete(
  "/:id",
  requirePermission("seguridad", "archivar"),
  requireStepUp({ exigeContrasena: true }),
  deleteUsuario,
);
router.patch(
  "/:id/restore",
  requirePermission("seguridad", "archivar"),
  requireStepUp({ exigeContrasena: true }),
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
// 🔴 **`exigeContrasena: true` — added by the 2026-09-02 closure audit,
// hallazgo F8 (auditor B-6).** The paragraph above stopped short: it is true
// that "every route above answers 403 to a session that has not proved one",
// but only once that account *has* a factor to prove. On deploy day, with
// zero of nine accounts registered and none verified (plan 4E made a
// verified address a factor), `tieneAlgunFactor` is `false` for everybody,
// including whichever administrator's cookie gets stolen — so without this
// option, this route sat in exactly the gap the paragraph above thought it
// had closed: a factor-less cookie, no `stepup_password`, and
// `requireStepUp`'s own third branch waves it through, same as it always
// did. `exigeContrasena` closes that specific gap: from the very first
// deploy, lifting a lockout costs the administrator's own current password,
// not merely a live cookie — the same requirement `requireStepUp.ts`'s own
// docstring on this option was already written to demand, and which this
// mount had never actually turned on.
router.patch(
  "/:id/desbloquear",
  requirePermission("seguridad", "editar"),
  requireStepUp({ exigeContrasena: true }),
  desbloquearUsuario,
);
// The escape hatch from §8 of the MFA design: an administrator clears
// somebody else's second factor from the browser. `editar`, the same
// permission `/desbloquear` above asks for and for the same reason — this
// is the other way an administrator undoes a state that leaves an account
// unable to log in. See `rescatarMfaDeUsuario` in `usuario.controller.ts`
// for the refusal this route adds on top of both gates — resetting your own
// factors through here is rejected even with the permission and a proved
// factor, because it would leave the caller's own session past
// `requireStepUp`'s gate on nothing but the cookie.
//
// 🔴 **`exigeContrasena: true` — same hallazgo F8, and the more severe half
// of it.** `rescatarMfaDeUsuario` deletes the target account's rows in all
// three factor tables and revokes every one of its live sessions and
// remembered devices — literally the "removes a credential" case
// `requireStepUp.ts`'s docstring on `exigeContrasena` names by name. Without
// this option, and with no account anywhere holding a factor yet, a stolen
// administrator cookie could clear the second factor of every one of the
// other eight accounts and sign them all out, in eight requests, without
// ever typing a password. `exigeContrasena` is what makes that cost the
// administrator's own current password instead of nothing.
router.post(
  "/:id/mfa/reset",
  requirePermission("seguridad", "editar"),
  requireStepUp({ exigeContrasena: true }),
  rescatarMfaDeUsuario,
);
router.get("/user/:user", requirePermission("seguridad", "ver"), searchUsuario_user);

/**
 * The list as a file.
 *
 * **POST, for a download.** `requireSameOrigin` only guards the writing verbs,
 * so a GET that assembles a spreadsheet is something any page on the internet
 * can make a logged-in employee's browser do, twenty times over, from an
 * `<img>` tag it never gets to read. Nothing is stolen; the server just spends
 * somebody else's memory and the only export slot it has. The report
 * generator's own export is a POST for this reason.
 *
 * The filters ride in the query string all the same, because they are the
 * listing's own parameters read by the listing's own function — see
 * `filtroDe*` in the controller.
 *
 * `exportLimiter` is shared with the generator on purpose: what is being
 * rationed is the one slot that builds documents, and a per-route budget would
 * let one person hold it four times over by rotating between the routes.
 */
router.post("/export", requirePermission("seguridad", "ver"), exportLimiter, exportarUsuarios);

// The full directory backs the security and bitácora screens.
router.get("/", requirePermission("seguridad", "ver"), getUsuario);

// Own record, or the permission. The profile page reads and edits whoever is
// logged in through these same endpoints, so requiring the module here would
// stop people changing their own password. Ownership is not a role permission
// and has no checkbox — see requirePermission.ts.
router.get("/:id", requireSelfOrPermission("seguridad", "ver"), searchUsuario);

/**
 * What one person did, and what was done to their account — the two listings
 * D1 moved here from `/api/evento/usuario/:id_usuario` and
 * `/api/bitacora/:id_usuario`.
 *
 * **Declared after `/user/:user` on purpose.** Both are two-segment patterns
 * with a parametric first segment, so declared *before* it they would swallow
 * `GET /api/usuario/user/eventos` and `/api/usuario/user/bitacora` — the search
 * for an account whose username is literally "eventos" or "bitacora". `id`
 * would be the string `"user"`, `Number("user")` is `NaN`, and the caller gets
 * a 403 or, with the permission, a 500 from Postgres refusing the cast.
 * `routeOrder.test.ts` would not catch it: it compares declared patterns
 * against each other, and neither of these covers `/user/:user` entirely.
 *
 * **The pairs are of the other module on purpose.** Asking about a person is
 * `seguridad.ver` and asking about their audit trail is `bitacora.ver`; the
 * parent mount does not decide the question. §3.7 of the spec allows it and
 * `routeGuards.test.ts` files them under the module that answers.
 *
 * 🔴 **The third argument of `requireSelfOrPermission` is not optional, and it
 * changed with the move.** It defaults to `"id"`, which is now correct — these
 * parameters used to be `:id_usuario`, and the argument named them. Copy the
 * old line across with `"id_usuario"` still in it and the ownership branch
 * compares `undefined` against the caller's id, never matches, and the gate
 * degrades to permission-only: everyone without the module silently loses their
 * own history and their own audit trail. Both screens swallow it —
 * `usePerfilData.ts` catches into `[]` — so it shows up as an empty list and
 * "Eventos atendidos: 0", never as an error. `evento.self.test.ts` and
 * `bitacora.self.test.ts` exist for these two lines; nothing else in the
 * repository can see them, because reading the chain never sends a request and
 * every other suite mocks `can` to true.
 */
router.get("/:id/eventos", requireSelfOrPermission("seguridad", "ver"), getEvento_usuario);
router.get("/:id/bitacora", requireSelfOrPermission("bitacora", "ver"), getBitacora);
//
// 🔴 **D6 reaches these three too, and the plan had left them off.** Editing an
// account, renaming it, changing its password: for somebody *else's* account
// these are exactly how a stolen administrator cookie takes the account over,
// which is the case D6 exists for. For your *own* account the cost is real
// and named here rather than hidden: the rename and password forms already
// carry `oldPass`, so the person types their current password twice — once in
// the form, once in the step-up window. The gate cannot tell target from self
// and must not learn to; a smaller wart than a password-reset door with no
// password on it.
router.put(
  "/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp({ exigeContrasena: true }),
  updateUsuario,
);
router.put(
  "/username/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp({ exigeContrasena: true }),
  chargeConfirmBudgetOnSelfChange,
  updateUserName,
);
router.put(
  "/userpass/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp({ exigeContrasena: true }),
  chargeConfirmBudgetOnSelfChange,
  updateUserPass,
);

export default router;
