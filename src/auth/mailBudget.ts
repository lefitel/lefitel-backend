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
 * Take one from today's budget, or refuse.
 *
 * `true` means the caller may send. `false` means it must not, and the reason
 * is already in the log — the caller's job is to skip the send, never to tell
 * the person asking. Telling them would say something about their address that
 * a uniform response exists to withhold.
 *
 * `motivo` names the flow for the log line, because "the budget ran out" is
 * only useful alongside what spent it.
 */
export function consumirPresupuestoDeCorreo(motivo: string): boolean {
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
