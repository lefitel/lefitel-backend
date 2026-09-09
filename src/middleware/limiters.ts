// The per-person budgets of the report machinery, and of everything that
// shares them.
//
// Every `rateLimit()` in this file counts against `perUser`: the account when
// there is a session, the address when there is not. `conteoLimiter` guards one
// route and lives here all the same, so that the four numbers the generator was
// decided with are read in one place, each with its reason next to it.
//
// This is a place to look first, not a rule for the whole system. The
// authentication surface keeps its own per-person budgets — the password
// confirmation, the passkey ceremonies — in `loginLimiters.ts`, next to the
// address-keyed ones they were designed with, and the upload budget keeps
// `uploadLimiters.ts`, whose header holds the argument for why uploads sit
// outside the permission matrix. Its `upload:` key prefix is insurance for the
// day a store is shared between limiters; it is not what keeps the counts apart
// today, and moving that budget here would not merge anything.
//
// Two of these are shared between routers by decision, and the reason is the
// same both times: what the budget rations is not a route, it is a cost of the
// process — the one export slot, or the database's time — and a budget per
// route lets one person spend that cost several times over by rotating routes.
//
// Every `rateLimit()` call builds its own in-memory store, so `u:7` in one
// budget is unrelated to `u:7` in another. (Hand one store object to two
// limiters and the library only logs a validation error; it does not stop you.)
// A test that resets a key has to reset it on the instance it spent.

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
 *
 * `ipKeyGenerator` has to stay in this function's source text: express-rate-limit
 * reads the key generator's source and logs a validation error for one that
 * mentions `req.ip` without it — the error that used to print on every boot.
 *
 * Every mount of these budgets sits behind `authenticate`, so the fallback is
 * not expected to run. If it ever did for a request with no address at all, the
 * key would be `ip:` — one bucket for every such caller, which is the shape a
 * key generator must never produce on purpose. Unreachable today, said here.
 */
export const perUser = (req: { user?: { id?: number }; ip?: string }) =>
  req.user?.id != null ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;

/**
 * Thirty heavy queries a minute, per person — one budget for every route that
 * runs one.
 *
 * Mounted on `POST /api/generator/query` and on the six fixed reports under
 * `/api/reporte`. **Shared by decision** (Isaias, 2026-09-04): the cost is the
 * database's time in this one process, and a person can spend it from seven
 * addresses. A budget per route would let one person run 210 of these a minute
 * by rotating between them; one bucket for the six reports and another for the
 * generator, 60.
 *
 * **What sharing costs, said out loud.** The two consumers are not the same
 * kind. A report screen spends one unit per press of Generar — Recorrido also
 * one per incident resolved or revised from its map, which is a hand's pace —
 * and never on a timer. The generator does: it re-runs the query 700 ms after
 * every change to the configuration, and every "Siguiente" is one more. So somebody building
 * a report in the generator can empty this budget and leave the six report
 * screens answering "espere un momento" for the rest of that minute without
 * having touched them. The reverse cannot happen at any rate a hand produces.
 * It is the same person both times, the sentence tells them to wait, and the
 * window is a minute: accepted, and written here so the next reader of a 429 on
 * Informes knows where to look.
 *
 * Keyed on the user, not the IP: behind a reverse proxy every request shares
 * the proxy's address, so an IP-keyed budget of 30 would be 30 for the entire
 * installation, and one person paging through a long report would lock
 * everyone else out.
 */
export const consultaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: perUser,
  // `{ message }` is what every failure in this API answers with. A limiter
  // replying in any other shape surfaces as an undefined message on screen.
  message: { message: "Demasiadas consultas seguidas. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The road-route proxy, and a bucket of its own rather than a share of the one
 * above.
 *
 * The comment on `consultaLimiter` — and the assertion that pins its seven
 * routes — say what that budget is for: a heavy query against our own database.
 * `POST /api/ruta/query` reads no rows at all. What it spends is
 * OpenRouteService's quota, which is somebody else's and is counted per day for
 * the whole company. Putting it in the query bucket would make opening a pole's
 * map eat from the reports' minute, which is precisely the "una ruta pagando un
 * presupuesto que no es el suyo" that `routeGuards.test.ts` refuses.
 *
 * Twenty a minute per person: the four screens ask once each time one is
 * opened, so twenty is far above a hand's pace and well under the provider's
 * own forty per minute.
 *
 * **What this does not bound, said out loud.** It is keyed per user, and the
 * provider's limit is global — nine people at twenty each is a hundred and
 * eighty, four times what ORS accepts in a minute. A per-user bucket cannot fix
 * that; only a shared budget of the kind `auth/mailBudget.ts` keeps could, and
 * that machinery is not worth building for nine accounts who never open forty
 * maps in a minute between them. If it ever happens, ORS answers 429, the
 * client draws the straight line it already draws, and — this is the part that
 * is new — `ruta.controller.ts` writes `ritmo` in the log, so the day it starts
 * happening is a day somebody can see.
 */
export const rutaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: perUser,
  message: { message: "Demasiados trazados seguidos. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Counting is asked while somebody types a filter value, so it needs a budget an
 * order of magnitude larger than running the report — and it can afford one: it
 * reads no rows, only an aggregate over the filtered set.
 */
export const conteoLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: perUser,
  message: { message: "Demasiadas comprobaciones seguidas. Espere un momento." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Ten files a minute, per person, across every endpoint that builds one.
 *
 * Mounted on `POST /api/generator/export` and on the three list downloads
 * (`POST /api/{poste,evento,usuario}/export`). **One budget, deliberately
 * shared.** The cost being limited is not "a report" or "a pole list", it is
 * assembling a document in memory — and only one of those runs at a time in
 * the whole process, so they are competing for the same thing whatever route
 * asked. A separate budget per route would let one person hold that slot forty
 * times a minute instead of ten by rotating between them.
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

/**
 * Saving, editing, archiving and copying a saved report in the generator.
 *
 * These were left unlimited on the grounds that they "share the global one" —
 * and there is no global one: `app.ts` rate-limits the login endpoint and
 * nothing else. So the cheapest write in the system was also the only
 * unbounded one, and each row it creates carries a configuration document. A
 * loop could fill the table as fast as the network allows.
 *
 * Sixty a minute is far more than anyone pressing Guardar, and low enough that
 * a script cannot use it to grow the database.
 */
export const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: perUser,
  message: { message: "Demasiados cambios seguidos. Espere un momento e intente de nuevo." },
  standardHeaders: true,
  legacyHeaders: false,
});
