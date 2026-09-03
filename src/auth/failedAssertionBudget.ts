// How many refused passwordless assertions one account gets written down,
// one line each, before the door stops counting them one by one.
//
// A budget on the *writing* and never on the refusing — the mail budget's
// lesson (`mailBudget.ts`): a middleware counts requests, and the request is
// not the resource. The resource here is a bitácora row filed under a name
// the caller chose, and the caller is anonymous.

import {
  LOGIN_WINDOW_MS,
  WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT,
} from "../config/security.js";

/**
 * What the door should do about this refusal, bitácora-wise.
 *
 * - `"registrar"` — write the ordinary line, as phase 1 does.
 * - `"resumir"` — the budget just ran out: write **one** line saying so, and
 *   nothing per attempt from here to the end of the window.
 * - `"callar"` — already resumed; write nothing. The refusal itself is
 *   unaffected in all three.
 */
export type VeredictoDeLinea = "registrar" | "resumir" | "callar";

interface Ventana {
  desde: number;
  fallos: number;
  /** The kinds of refusal already written in this window — see below. */
  motivos: Set<string>;
}

/**
 * In memory and per process, like every bucket in `loginLimiters.ts`, and
 * with the same consequence: a restart forgets it, and a second process
 * would keep its own. Keyed by account id rather than by anything the
 * request carries, which is the whole point — see the constant's comment.
 */
const ventanas = new Map<number, Ventana>();

/**
 * Count one refused assertion against this account and say whether it still
 * earns its own line.
 *
 * **The first refusal of each `motivo` in a window is always written, ceiling
 * or no ceiling.** Without that, whoever holds a victim's credential id could
 * spend the ten lines on garbage first and then use the key of an archived
 * account — or race a deletion — in silence: the ceiling would have swallowed
 * the one line that mattered. So the ceiling bounds *repeats*; a kind of
 * refusal the window has not seen yet goes through once. There are six kinds,
 * so the most an attacker can add past the ceiling is five lines.
 *
 * The window starts at the first refusal and is fixed, not sliding — the
 * `express-rate-limit` shape, so the two budgets behave alike. Entries older
 * than a window are dropped on the way in rather than by a timer: this table
 * only ever holds accounts somebody is failing against right now, so there
 * is nothing to sweep that the next call does not sweep itself.
 *
 * `ahora` is a parameter for the tests; production never passes it.
 */
export function contabilizarFalloAnonimo(
  id_usuario: number,
  motivo: string,
  ahora: number = Date.now(),
): VeredictoDeLinea {
  podar(ahora);

  const actual = ventanas.get(id_usuario);
  if (!actual) {
    ventanas.set(id_usuario, { desde: ahora, fallos: 1, motivos: new Set([motivo]) });
    return "registrar";
  }

  actual.fallos += 1;
  if (!actual.motivos.has(motivo)) {
    actual.motivos.add(motivo);
    return "registrar";
  }
  if (actual.fallos <= WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT) return "registrar";
  if (actual.fallos === WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT + 1) return "resumir";
  return "callar";
}

/** Forget one account's window. For the tests, which share this process's map. */
export function olvidarFallosAnonimos(id_usuario: number): void {
  ventanas.delete(id_usuario);
}

function podar(ahora: number): void {
  for (const [id, ventana] of ventanas) {
    if (ahora - ventana.desde >= LOGIN_WINDOW_MS) ventanas.delete(id);
  }
}
