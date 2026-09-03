// The per-account ceiling on what a refused anonymous assertion may write —
// plan 4C phase 2, Task 14. What the address buckets cannot see: the same
// account buried from many addresses.

import { describe, it, expect, beforeEach } from "vitest";
import { contabilizarFalloAnonimo, olvidarFallosAnonimos } from "./failedAssertionBudget.js";
import {
  LOGIN_WINDOW_MS,
  WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT,
} from "../config/security.js";

const ANA = 42;
const BEATRIZ = 43;
const T0 = 1_700_000_000_000;
const N = WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT;
const FIRMA = "firma-invalida";

beforeEach(() => {
  // The map is a module singleton, like every bucket: each test starts clean.
  olvidarFallosAnonimos(ANA);
  olvidarFallosAnonimos(BEATRIZ);
});

describe("contabilizarFalloAnonimo", () => {
  it("lets exactly the configured number of refusals of one kind be written, one line each", () => {
    for (let i = 1; i <= N; i += 1) {
      expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + i), `fallo ${i}`).toBe("registrar");
    }
  });

  it("asks for one summary line on the first refusal past the ceiling, and silence after it", () => {
    for (let i = 1; i <= N; i += 1) contabilizarFalloAnonimo(ANA, FIRMA, T0 + i);
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 100)).toBe("resumir");
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 101)).toBe("callar");
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 102)).toBe("callar");
  });

  // 🔴 The line the ceiling must not be able to swallow: whoever holds the
  // credential id can spend the ten on garbage first. A kind of refusal the
  // window has not seen goes through once, ceiling or no ceiling.
  it("still writes the first refusal of a kind it has not seen, past the ceiling", () => {
    for (let i = 1; i <= N + 3; i += 1) contabilizarFalloAnonimo(ANA, FIRMA, T0 + i);
    expect(contabilizarFalloAnonimo(ANA, "cuenta-archivada", T0 + 200)).toBe("registrar");
    // Once. The repeat is a repeat.
    expect(contabilizarFalloAnonimo(ANA, "cuenta-archivada", T0 + 201)).toBe("callar");
    expect(contabilizarFalloAnonimo(ANA, "credencial-borrada-durante-la-ceremonia", T0 + 202)).toBe("registrar");
  });

  it("counts a new kind towards the ceiling, so kinds cannot be used to write more than the ceiling plus one each", () => {
    // Nine of one kind, then a second kind: the tenth line overall is the
    // second kind's first, and the eleventh — of either — is the summary.
    for (let i = 1; i <= N - 1; i += 1) contabilizarFalloAnonimo(ANA, FIRMA, T0 + i);
    expect(contabilizarFalloAnonimo(ANA, "verificacion-rechazada", T0 + 50)).toBe("registrar");
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 51)).toBe("resumir");
    expect(contabilizarFalloAnonimo(ANA, "verificacion-rechazada", T0 + 52)).toBe("callar");
  });

  it("keeps two accounts apart: a flood against one costs the other nothing", () => {
    for (let i = 1; i <= N + 5; i += 1) contabilizarFalloAnonimo(ANA, FIRMA, T0 + i);
    expect(contabilizarFalloAnonimo(BEATRIZ, FIRMA, T0 + 200)).toBe("registrar");
  });

  it("starts a fresh window once the old one has run its course", () => {
    for (let i = 1; i <= N + 1; i += 1) contabilizarFalloAnonimo(ANA, FIRMA, T0 + i);
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 500)).toBe("callar");
    // Fixed window from the first refusal, not sliding: one millisecond short
    // of a full window is still the same window.
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 1 + LOGIN_WINDOW_MS - 1)).toBe("callar");
    expect(contabilizarFalloAnonimo(ANA, FIRMA, T0 + 1 + LOGIN_WINDOW_MS)).toBe("registrar");
  });
});
