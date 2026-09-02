// The daily ceiling on outbound account mail, counted where the mail is
// actually sent.
//
// **Why this is not a rate limiter.** It was one: `passwordForgotDailyLimiter`
// in `recoveryLimiters.ts`, an `express-rate-limit` bucket with a single
// global key, mounted in front of `/password/forgot`. Middleware runs before
// the handler, so it could only count *requests* — and the thing worth
// protecting is Resend's quota, which requests do not spend.
//
// That gap was an attack, not a nuance. Fifty POSTs carrying `{"email":"x"}`
// answer 400, send nothing, spend none of the quota, and exhausted the whole
// company's daily recovery budget for twenty-four hours. `RateLimit-Remaining`
// even counted it down for whoever was doing it. The defence was cheaper to
// defeat than the thing it defended.
//
// Counting at the send site fixes both halves: a request that sends no mail
// costs nothing, and a request that does send is measured against the real
// resource. It also stops being visible to the caller, which suits
// `/password/forgot` — a 429 that only appears once somebody's address turns
// out to have an account would have been the enumeration oracle that endpoint
// is built to avoid.
//
// **In memory, and that is a deliberate limit, not an oversight.** It resets
// when the process restarts, exactly like every `express-rate-limit` bucket in
// this codebase, which use the same default store. A second instance would
// have its own count and the ceiling would double. Both are acceptable at this
// size — one container, tens of users — and both stop being acceptable the day
// this runs more than once, which is when this needs to move to the database.

import { MAIL_DAILY_BUDGET, MAIL_DAILY_WINDOW_MS } from "../config/security.js";
// Type-only, so nothing of `mailer.ts` exists here at runtime and the pair does
// not form an import cycle — `mailer.ts` imports the function below for real.
import type { FlujoDeCorreo } from "./mailer.js";
import { log } from "../utils/logger.js";

const budgetLog = log("mailBudget");

/**
 * When each send happened, oldest first. A sliding window rather than a
 * counter that resets on the hour: with a fixed window, whoever wanted the
 * budget gone could spend it twice in two minutes either side of the reset.
 * At most `MAIL_DAILY_BUDGET` timestamps ever live here.
 */
let enviosRecientes: number[] = [];

function descartarLosViejos(ahora: number): void {
  const limite = ahora - MAIL_DAILY_WINDOW_MS;
  enviosRecientes = enviosRecientes.filter((t) => t > limite);
}

/**
 * Whether today's window still has room, without spending anything.
 *
 * The look-before-you-leap half of Decision 2 in
 * `docs/plans/2026-09-01-defectos-previos-al-4b.md`: some callers have to
 * decide something *destructive* before a real send happens, and by the time
 * `consumirPresupuestoDeCorreo` below would tell them the budget is gone, the
 * damage is already done. `email.controller.ts`'s `sendVerificationEmail` is
 * the concrete case — it wipes the account's verified address and burns its
 * pending tokens before it can mint a new one, so it has to know *first*.
 * Same shape `middleware/requireStepUp.ts` already uses for the same reason:
 * see that file's own comment on `passwordConfirmLimiter.getKey` for why
 * asking costs nothing and committing does.
 *
 * Never treat this as a substitute for the real charge. Asking here and then
 * not calling `consumirPresupuestoDeCorreo` for the message this was asking
 * about would mean the send that follows was never actually counted —
 * `enviarCorreo` is the one place that does, once per real message, and this
 * function exists only to gate a step ahead of that, never to replace it.
 */
export function hayPresupuestoDeCorreo(): boolean {
  const ahora = Date.now();
  descartarLosViejos(ahora);
  return enviosRecientes.length < MAIL_DAILY_BUDGET;
}

/**
 * Take one from today's budget, or refuse. Called from exactly one place —
 * `auth/mailer.ts`'s `enviarCorreo`, once per message it is actually about to
 * hand to Resend — which is what makes a request that sends no mail cost
 * nothing and a request that sends three messages cost three. No controller
 * calls this directly; see `hayPresupuestoDeCorreo` above for the read-only
 * check they use instead.
 *
 * `true` means the caller may send. `false` means it must not, and the reason
 * is already in the log — the caller's job is to skip the send, never to tell
 * the person asking. Telling them would say something about their address that
 * a uniform response exists to withhold.
 *
 * `motivo` is a `FlujoDeCorreo` and **not a `string`, deliberately**: with a
 * plain `string` the natural thing to hand it is `correo.asunto`, four of whose
 * seven values in this codebase interpolate a username — so the line that says
 * the budget ran out would name whoever was being rescued, and the field would
 * stop being summable per flow. Measured: with the parameter typed `string`,
 * passing the subject compiles clean. The narrow type is the whole guard.
 *
 * It names the flow for the log line, because "the budget ran out" is
 * only useful alongside what spent it.
 */
export function consumirPresupuestoDeCorreo(motivo: FlujoDeCorreo): boolean {
  const ahora = Date.now();
  descartarLosViejos(ahora);

  if (enviosRecientes.length >= MAIL_DAILY_BUDGET) {
    budgetLog.error(
      { motivo, gastados: enviosRecientes.length, tope: MAIL_DAILY_BUDGET },
      "presupuesto diario de correo agotado: NO se envió. Alguien pidió más correo del que cabe en la cuota, o hay un abuso en marcha.",
    );
    return false;
  }

  enviosRecientes.push(ahora);
  // One line per send would drown the log, so only the approach to the ceiling
  // is worth saying out loud — which is also the only moment anybody could act
  // on it before people start not receiving mail.
  if (enviosRecientes.length >= MAIL_DAILY_BUDGET * 0.8) {
    budgetLog.warn(
      { motivo, gastados: enviosRecientes.length, tope: MAIL_DAILY_BUDGET },
      "presupuesto diario de correo por encima del 80%",
    );
  }
  return true;
}

/** For tests: forget everything spent. Never called by the application. */
export function reiniciarPresupuestoDeCorreo(): void {
  enviosRecientes = [];
}

/** For tests and diagnostics: how many sends the current window still allows. */
export function presupuestoRestante(): number {
  descartarLosViejos(Date.now());
  return Math.max(0, MAIL_DAILY_BUDGET - enviosRecientes.length);
}
