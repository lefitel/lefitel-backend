// How much room somebody gets to be wrong.
//
// Three budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops a guess, and the pair stops one machine grinding one
// account. The arithmetic of the third is the part that goes wrong quietly —
// an escalation with no ceiling is a button for locking a colleague out.

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import {
  LOGIN_IP_LIMIT,
  LOGIN_ACCOUNT_IP_LIMIT,
  LOGIN_WINDOW_MS,
  LOCKOUT_AFTER_FAILURES,
  LOCKOUT_BASE_MINUTES,
  LOCKOUT_MAX_MINUTES,
} from "../config/security.js";

/** The username a login attempt is about, normalised the way the lookup does. */
function usuarioDe(req: Request): string {
  const u = (req.body as { user?: unknown } | undefined)?.user;
  return typeof u === "string" ? u.trim().toLowerCase() : "";
}

/**
 * By address, counting failures only.
 *
 * The budget it replaces was ten per quarter hour counting successes as well,
 * which behind a NAT is ten for the whole office. It also keyed on the raw
 * address: `ipKeyGenerator` folds IPv6 into its /56 block, without which one
 * holder of a prefix walks through billions of distinct keys.
 *
 * A hundred is deliberately generous. This bucket exists to stop a flood; the
 * per-account bucket below is what stops a guess, and it is the one with teeth.
 */
export const loginIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_IP_LIMIT,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "")}`,
  message: { message: "Demasiados intentos desde esta red. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * By address and account together, so one machine cannot grind one name even
 * while the address budget still has room.
 */
export const loginAccountIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_ACCOUNT_IP_LIMIT,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `ipu:${ipKeyGenerator(req.ip ?? "")}:${usuarioDe(req)}`,
  message: { message: "Demasiados intentos. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Whether this account is resting right now. */
export function estaBloqueada(u: { failed_attempts?: number; locked_until?: Date | null }): boolean {
  if (!u.locked_until) return false;
  return new Date(u.locked_until).getTime() > Date.now();
}

/**
 * The account's state after one more failure.
 *
 * The wait doubles, and stops doubling at the ceiling. Without a ceiling, an
 * escalation reaches hours, and in a company where everybody knows everybody's
 * username that is a button for locking a colleague out of their day.
 */
export function siguienteBloqueo(fallosPrevios: number): {
  failed_attempts: number;
  locked_until: Date | null;
} {
  const fallos = fallosPrevios + 1;
  if (fallos < LOCKOUT_AFTER_FAILURES) {
    return { failed_attempts: fallos, locked_until: null };
  }
  const exceso = fallos - LOCKOUT_AFTER_FAILURES;
  const minutos = Math.min(LOCKOUT_BASE_MINUTES * 2 ** exceso, LOCKOUT_MAX_MINUTES);
  return { failed_attempts: fallos, locked_until: new Date(Date.now() + minutos * 60_000) };
}
