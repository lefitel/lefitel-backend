// A daily ceiling on outbound account mail, one per provider, counted where
// the mail is actually sent — plan 4E, Task 7; design §4.3.
//
// **Why this is not a rate limiter.** It was one: `passwordForgotDailyLimiter`
// in `recoveryLimiters.ts`, an `express-rate-limit` bucket with a single
// global key, mounted in front of `/password/forgot`. Middleware runs before
// the handler, so it could only count *requests* — and the thing worth
// protecting is the provider's quota, which requests do not spend.
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
// **Since plan 4E there is one of these per provider, and each keeps a
// reserve.** The single counter used to be `MAIL_DAILY_BUDGET = 80` against
// Resend's 100, and the twenty units between them existed so that a stranger
// burning the budget could never be the reason a takeover warning was not
// sent. With five providers the same property is kept per provider, and it
// now protects the login as well: since a verified address is a second
// factor, the code by email is on the path of every login, and
// `/password/forgot` — which asks for no credential — could otherwise spend
// 648 messages a day across nine known addresses, more than the whole chain
// holds. So the last quarter of every provider's ceiling is spendable only by
// `FLUJOS_RESERVADOS`: the login code and the security notices. Everything
// else stops at 75 %.
//
// **In memory, and that is a deliberate limit, not an oversight.** It resets
// when the process restarts, exactly like every `express-rate-limit` bucket in
// this codebase, which use the same default store. A second instance would
// have its own count and the ceiling would double. Both are acceptable at this
// size — one container, tens of users — and both stop being acceptable the day
// this runs more than once, which is when this needs to move to the database.
// With five providers the cost of a restart is relaying earlier than needed.

import { MAIL_DAILY_WINDOW_MS, MAIL_RESERVA_FRACCION } from "../config/security.js";
// Type-only, so nothing of `mailer.ts` exists here at runtime and the pair does
// not form an import cycle.
import type { FlujoDeCorreo } from "./mailer.js";
import { log } from "../utils/logger.js";

const budgetLog = log("mailBudget");

/**
 * The flows that may spend a provider's reserved share. Two kinds, one
 * reason: neither may be the thing a flood of the other flows crowds out.
 * The login code, because since plan 4E it is how most people get in; the
 * security notices, because each one is the trace of a takeover in progress.
 */
export const FLUJOS_RESERVADOS: ReadonlySet<FlujoDeCorreo> = new Set<FlujoDeCorreo>([
  "mfa/codigo",
  "password/aviso-restablecida",
  "email/aviso-cambio",
  "rescate/aviso",
]);

export interface Presupuesto {
  readonly nombre: string;
  readonly tope: number;
  /** Whether a message of this flow could be sent now, without spending anything. */
  hay(flujo: FlujoDeCorreo): boolean;
  /** Take one unit for this flow, or refuse. The refusal is already in the log. */
  consumir(flujo: FlujoDeCorreo): boolean;
  /** Mark the whole ceiling spent — the provider itself said we are over. */
  agotar(): void;
  /** How many units the current window still allows for an unreserved flow. */
  restante(): number;
  /** For tests: forget everything spent. */
  reiniciar(): void;
}

/**
 * One provider's counter. `reserva` units of `tope` are held back for the
 * reserved flows; the default is `MAIL_RESERVA_FRACCION` of the ceiling.
 *
 * A sliding window rather than a counter that resets on the hour: with a
 * fixed window, whoever wanted the budget gone could spend it twice in two
 * minutes either side of the reset. At most `tope` timestamps ever live here.
 */
export function crearPresupuesto(
  nombre: string,
  tope: number,
  reserva: number = Math.floor(tope * MAIL_RESERVA_FRACCION),
): Presupuesto {
  let enviosRecientes: number[] = [];
  let avisadoDel80 = false;

  const descartarLosViejos = (ahora: number): void => {
    const limite = ahora - MAIL_DAILY_WINDOW_MS;
    enviosRecientes = enviosRecientes.filter((t) => t > limite);
  };
  const techoDe = (flujo: FlujoDeCorreo): number => (FLUJOS_RESERVADOS.has(flujo) ? tope : tope - reserva);

  return {
    nombre,
    tope,
    hay(flujo) {
      descartarLosViejos(Date.now());
      return enviosRecientes.length < techoDe(flujo);
    },
    consumir(flujo) {
      const ahora = Date.now();
      descartarLosViejos(ahora);
      if (enviosRecientes.length >= techoDe(flujo)) {
        budgetLog.error(
          { proveedor: nombre, motivo: flujo, gastados: enviosRecientes.length, tope, techo: techoDe(flujo) },
          "presupuesto diario de correo de este proveedor agotado para este flujo: NO se envió por él. " +
            "Alguien pidió más correo del que cabe en la cuota, o hay un abuso en marcha.",
        );
        return false;
      }
      enviosRecientes.push(ahora);
      // One line per send would drown the log, so only the crossing of the
      // 80 % line is said out loud — once, until the window rolls back under
      // it — which is also the only moment anybody could act on it before
      // people start not receiving mail.
      const enZonaRoja = enviosRecientes.length >= tope * 0.8;
      if (enZonaRoja && !avisadoDel80) {
        budgetLog.warn(
          { proveedor: nombre, motivo: flujo, gastados: enviosRecientes.length, tope },
          "presupuesto diario de correo de este proveedor por encima del 80%",
        );
      }
      avisadoDel80 = enZonaRoja;
      return true;
    },
    agotar() {
      const ahora = Date.now();
      descartarLosViejos(ahora);
      while (enviosRecientes.length < tope) enviosRecientes.push(ahora);
    },
    restante() {
      descartarLosViejos(Date.now());
      return Math.max(0, tope - reserva - enviosRecientes.length);
    },
    reiniciar() {
      enviosRecientes = [];
      avisadoDel80 = false;
    },
  };
}
