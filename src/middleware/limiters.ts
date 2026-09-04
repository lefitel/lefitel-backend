// The budgets shared by more than one router.
//
// `perUser` and the export budget were written inside `generador.routes.ts`,
// which was right while the report generator was the only thing in the system
// that could build a file. It is not any more: the pole, incident and user
// lists each export too, and three new routes that build spreadsheets with no
// budget at all would be three ways to keep the single export slot busy in a
// loop — starving the generator without spending a single unit of its budget.

import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * The key every budget here counts against.
 *
 * Keyed on the user, not the address. Behind a reverse proxy every request
 * shares the proxy's address, so an address-keyed budget would be one budget
 * for the whole installation. The fallback folds IPv6 into its /56 block,
 * because a raw address let one holder of a prefix walk through billions of
 * distinct keys and spend the budget as many times over. Namespaced so a user
 * id can never collide with an address.
 */
export const perUser = (req: { user?: { id?: number }; ip?: string }) =>
  req.user?.id != null ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;

/**
 * Ten files a minute, per person, across every endpoint that builds one.
 *
 * **One budget, deliberately shared.** The cost being limited is not "a report"
 * or "a pole list", it is assembling a document in memory — and only one of
 * those runs at a time in the whole process, so they are competing for the same
 * thing whatever route asked. A separate budget per route would let one person
 * hold that slot forty times a minute instead of ten by rotating between them.
 *
 * Ten is generous for somebody pressing a button and low enough that a script
 * cannot use it to exhaust the server.
 */
export const exportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  keyGenerator: perUser,
  message: { message: "Demasiadas exportaciones seguidas. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});
