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
import { asignarRol } from "../controllers/usuarioRol.controller.js";
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
 * Confirming your own password costs something on `PUT /userpass/:id`, and
 * only when it was wrong.
 *
 * `updateUserPass` compares a password, and an authenticated endpoint that
 * compares an unlimited number of them is a password oracle for whoever
 * already stole a session — the sentence `passwordConfirmLimiter` exists for.
 * The oracle here is a clean one: a caller can send a guess together with a new
 * password that fails the policy and read the answer off the difference between
 * 401 (the guess was wrong) and 400 (the guess was right, and the new password
 * is too short). Unlimited, from one session, counting nothing anywhere. This
 * closes a hole older than the plan that mounted it.
 *
 * 🔴 **It used to be mounted on the rename as well, and is not any more.**
 * `updateUserName` compared an `oldPass` of its own until the
 * reauthentication window moved that demand up to the gate. There is nothing
 * left on `/username/:id` for this to charge for — the gate charges its own
 * wrong answers, out of this same `pc:<id>` bucket — so leaving the mount there
 * would be a middleware that reads a body field nobody writes and bills
 * nobody. What did **not** change is the sharing: the gate on every route and
 * this one function still count against one bucket per account, because it is
 * one secret being guessed at.
 *
 * The lockout cannot serve as that limit. A wrong `oldPass` deliberately does
 * not move `failed_attempts` — see the block in the handler — because
 * mistyping your own password while changing it must not be able to shut you
 * out of the ERP.
 *
 * **What keeps a stranger from emptying somebody else's allowance is this
 * function, not where it is mounted.** Charged only when the request actually
 * confirms a password, decided by `requiresOwnPassword` — the very function the
 * handler branches on, so the limit and the check cannot drift apart. Three
 * things follow. An administrator resetting *other people's* passwords sends no
 * `oldPass` and pays nothing **here**; what they do send is `stepup_password` to
 * the gate ahead of this, which charges only a wrong one, so legitimate
 * administrative work still costs nothing — billing it would answer 429 to the
 * sixth piece of it in a quarter of an hour. Nobody can dodge the budget by
 * mis-spelling the password field, because what is measured is *whose* account
 * is being changed, not what the body happens to carry. And a caller reaching
 * for an account that is not theirs charges nothing at all — not their own
 * bucket and not the target's — because the only bucket this could touch is the
 * caller's own and it is not touched.
 *
 * **Mounted after the permission guard, and that order is on purpose even though
 * nothing observable depends on it today.** The two conditions coincide:
 * `requiresOwnPassword` is true exactly when the target is the caller, and
 * `requireSelfOrPermission` always lets the caller through for their own record,
 * so no request exists that the guard refuses and this would have charged. The
 * order is asserted structurally in `app.auth.test.ts` rather than through a
 * response, because that is the honest way to pin a property no response can
 * show — and it is worth pinning: the day the charge condition widens (an
 * administrator sending `oldPass` for somebody else, say), this order becomes
 * the only thing between a stranger and a stranger's allowance. This comment
 * used to claim the protection came from the order, and a test claimed to hold
 * it while passing with the two swapped.
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
// 🔴 **Every write on this router takes the ten-minute window — decision of
// 2026-10-10 (Isaias, "Todo, sin excepciones", risks put to him twice).** Plan
// 4C's decision D6 (2026-09-02) had put the caller's password on every request
// for each write here, §4.1 of
// `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md` cut that to the
// ones whose result outlives every remedy the victim has, and the 2026-10-10
// decision removed the rest. No route asks for the password on every request
// any more.
//
// **The accepted cost.** The writes that used to be exempt are the ones whose
// result survives the victim changing their own password, `logout-all`, a
// factor reset and the console rescue, because it lives in another account or
// another credential: creating an account, archiving one, handing out a role,
// rewriting somebody else's password, clearing their lockout or their factors.
// Inside the window a hijacked session can do any of them. That is a cost
// chosen with the risk stated, not a property the gate still provides.
//
// **Which options each mount carries is `STEP_UP_OPTIONS` in
// `routeGuards.test.ts`**, and no figure here: that table compares the whole
// option object against the real app in both directions.
//
// **The window is not an open door.** The gate still runs: outside the ten
// minutes every one of these answers 403, and the way through is the caller's
// own password if the account has no factor, or a factor proved recently if it
// has one. What the window buys is that one confirmation covers the batch of
// edits somebody sat down to make.
router.post(
  "/",
  requirePermission("seguridad", "crear"),
  requireStepUp(),
  createUsuario,
);
router.delete(
  "/:id",
  requirePermission("seguridad", "archivar"),
  requireStepUp(),
  deleteUsuario,
);
// Undoing an archive takes the same window as the archiving above. Archiving is
// the half with no way back from the app — the self-archive refusal in
// `deleteUsuario` (`usuario.controller.ts`) spells that out — and that is an
// accepted cost of the 2026-10-10 decision, not something the gate prevents.
router.patch(
  "/:id/restore",
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
// as long as the routes above accepted exactly what this one accepted. They
// did while the gate still had a branch that let a factor-less account through
// on nothing but the cookie — no `stepup_password` needed, on all of them
// alike. **That branch is gone**, deleted by Task 3 of the
// reauthentication-window plan: every account has something to type now, so
// the routes above stopped accepting what this one used to.
//
// What ends that argument is what this route protects. `failed_attempts` and
// `locked_until` are the login lockout, and they are the only brake against
// guessing a password that lives in the database: the rate limiters that also
// count per account (`loginLimiters.ts`) keep their counters in a
// `MemoryStore`, so they reset with the process and never span more than their
// own window. A stolen administrator cookie clearing those on any account it
// chooses is not a smaller act than the routes beside it, whatever permission
// the caller holds. See `desbloquearUsuario` in `usuario.controller.ts`, which
// writes both to zero and NULL and files a `critical` line saying what it
// undid.
//
// 🔴 **Hallazgo F8 (2026-09-02 closure audit, auditor B-6), reopened by the
// decision of 2026-10-10.** This mount used to demand the caller's own current
// password on every request, never a window opened ten minutes ago by
// something else, so lifting somebody's lockout cost a secret a stolen cookie
// does not carry. It takes the window now: inside it, a hijacked session can
// clear the lockout counters of any account it chooses. Accepted cost.
router.patch(
  "/:id/desbloquear",
  requirePermission("seguridad", "editar"),
  requireStepUp(),
  desbloquearUsuario,
);
// The escape hatch from §8 of the MFA design: an administrator clears
// somebody else's second factor from the browser. `editar`, the same
// permission `/desbloquear` above asks for and for the same reason — this
// is the other way an administrator undoes a state that leaves an account
// unable to log in. See `rescatarMfaDeUsuario` in `usuario.controller.ts`
// for the refusal this route adds on top of both gates — resetting your own
// factors through here is rejected even with the permission and a proved
// factor. The reason is in that function's comment.
//
// 🔴 **Same hallazgo F8, reopened by the decision of 2026-10-10, and the more
// severe half of it.** `rescatarMfaDeUsuario` deletes the target account's rows
// in all three factor tables and revokes every one of its live sessions and
// remembered devices — a route that removes credentials. This mount used to
// demand the administrator's own password on every request, so a stolen cookie
// could not clear other accounts' second factors even inside a window the real
// administrator had opened for something ordinary. It takes the window now: a
// hijacked session can do exactly that, one request each, without typing a
// password. Accepted cost.
router.post(
  "/:id/mfa/reset",
  requirePermission("seguridad", "editar"),
  requireStepUp(),
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

// The only route in the API that writes the `id_rol` of an account that
// already exists. It came out of `PUT /:id` below, which is also the route a
// person edits their own profile through: leaving the role there and taking the
// whole route out of the reauthentication window would have put the second
// password prompt back on "save my telephone number", which is where this whole
// piece of work started.
//
// `roles.editar` and not `seguridad.editar`, the split the permission matrix
// already draws: whoever may fix a colleague's telephone number must not
// thereby be able to hand out administrator.
//
// Takes the window like every gated route (decision of 2026-10-10). It used to
// demand the caller's own password on every request, because handing out a role
// is handing out authority and the account promoted keeps its **own**
// credentials, so the promotion outlives the victim changing their password,
// `logout-all`, a factor reset and the console rescue. Inside the window a
// hijacked session can now assign roles; accepted cost.
//
// Declared ahead of `PUT /:id`: one segment cannot match two, so Express
// reaches both either way and `routeOrder.test.ts` is silent about the pair —
// this is §3.2's ordering rule kept by hand, not a shadowing hazard.
router.put(
  "/:id/rol",
  requirePermission("roles", "editar"),
  requireStepUp(),
  asignarRol,
);
//
// 🔴 **The three where the stakes differ most, though the gate is now the same
// on all of them.** Editing an account and renaming one are visible and
// reversible by the person it happened to. A password written through
// `/userpass` can lock them out of their own account, and `requiresOwnPassword`
// is false when the target is somebody else — so for an administrator changing
// *another* account's password, the gate is the only thing in the request that
// asks for a secret at all, and inside the window it asks for none (decision of
// 2026-10-10; it used to ask for the caller's password every time).
//
// **These two are why the window exists.** `PUT /username/:id` is the operation
// the whole reauthentication design started from: renaming yourself asked for
// the password twice in one request — once in the form as `oldPass`, and once
// again in the step-up dialog. Both halves of that are gone now. The form's
// field went with the handler's own check, so the gate is the only thing that
// asks; and the window means one confirmation covers ten minutes of ordinary
// editing instead of one per request. The gate still runs — outside the window
// this answers 403 like everything else behind it.
router.put(
  "/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp(),
  updateUsuario,
);
// No `chargeConfirmBudgetOnSelfChange` on this one, unlike its neighbour: the
// rename compares no password of its own any more, so there is nothing here to
// bill. The gate above still charges a wrong `stepup_password` against the same
// per-account bucket, which is where a rename's guessing is counted now.
router.put(
  "/username/:id",
  requireSelfOrPermission("seguridad", "editar"),
  requireStepUp(),
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
