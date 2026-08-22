// How much room somebody gets to be wrong.
//
// Three budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops a guess, and the pair stops one machine grinding one
// account. The arithmetic of the third is the part that goes wrong quietly —
// an escalation with no ceiling is a button for locking a colleague out.

import { describe, it, expect } from "vitest";
import { estaBloqueada, siguienteBloqueo } from "./loginLimiters.js";
import { LOCKOUT_AFTER_FAILURES, LOCKOUT_MAX_MINUTES } from "../config/security.js";

describe("estaBloqueada", () => {
  it("is false for an account that has never failed", () => {
    expect(estaBloqueada({ failed_attempts: 0, locked_until: null })).toBe(false);
  });

  it("is false once the wait has passed", () => {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(estaBloqueada({ failed_attempts: 9, locked_until: ayer })).toBe(false);
  });

  it("is true while the wait is running", () => {
    const luego = new Date(Date.now() + 60_000);
    expect(estaBloqueada({ failed_attempts: 5, locked_until: luego })).toBe(true);
  });
});

describe("siguienteBloqueo", () => {
  it("does not lock before the threshold", () => {
    const r = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 2);
    expect(r.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES - 1);
    expect(r.locked_until).toBeNull();
  });

  it("locks on reaching the threshold", () => {
    const r = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 1);
    expect(r.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES);
    expect(r.locked_until).toBeInstanceOf(Date);
  });

  it("grows the wait with each further failure", () => {
    const primero = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 1).locked_until!.getTime();
    const despues = siguienteBloqueo(LOCKOUT_AFTER_FAILURES + 1).locked_until!.getTime();
    expect(despues).toBeGreaterThan(primero);
  });

  it("never waits longer than the ceiling", () => {
    // Everybody in a company of sixty knows the boss's username. Without a
    // ceiling, five wrong passwords a day keep that account shut indefinitely.
    const r = siguienteBloqueo(40);
    const minutos = (r.locked_until!.getTime() - Date.now()) / 60_000;
    expect(minutos).toBeLessThanOrEqual(LOCKOUT_MAX_MINUTES + 0.1);
  });
});
