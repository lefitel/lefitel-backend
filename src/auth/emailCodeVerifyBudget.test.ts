// `emailCodeVerifyBudget` — the per-account, per-process cap on how many
// email-code verifications the server will compute per quarter hour. What
// it bounds is bcrypt, not the code: the row charges the code's attempts.

import { describe, it, expect, beforeEach } from "vitest";
import { admitirIntentoDeCorreo, olvidarIntentosDeCorreo } from "./emailCodeVerifyBudget.js";
import { EMAIL_CODE_VERIFY_LIMIT, LOGIN_WINDOW_MS } from "../config/security.js";

const YO = 7;
const OTRO = 9;
const T0 = Date.parse("2026-09-03T10:00:00.000Z");

beforeEach(() => {
  olvidarIntentosDeCorreo(YO);
  olvidarIntentosDeCorreo(OTRO);
});

describe("admitirIntentoDeCorreo", () => {
  it("admits exactly the limit, and refuses the one after", () => {
    for (let i = 0; i < EMAIL_CODE_VERIFY_LIMIT; i++) {
      expect(admitirIntentoDeCorreo(YO, T0 + i), `intento ${i + 1}`).toBe(true);
    }
    expect(admitirIntentoDeCorreo(YO, T0 + EMAIL_CODE_VERIFY_LIMIT)).toBe(false);
    expect(admitirIntentoDeCorreo(YO, T0 + EMAIL_CODE_VERIFY_LIMIT + 1)).toBe(false);
  });

  it("counts each account on its own", () => {
    for (let i = 0; i <= EMAIL_CODE_VERIFY_LIMIT; i++) admitirIntentoDeCorreo(YO, T0 + i);
    expect(admitirIntentoDeCorreo(OTRO, T0)).toBe(true);
  });

  it("frees an attempt the moment it leaves the window, and not before", () => {
    for (let i = 0; i <= EMAIL_CODE_VERIFY_LIMIT; i++) admitirIntentoDeCorreo(YO, T0 + i);
    expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS - 1)).toBe(false);
    expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS)).toBe(true);
  });

  // Sliding, not fixed: no quarter-hour span ever admits more than the limit.
  it("never lets the boundary double the limit", () => {
    const mitad = EMAIL_CODE_VERIFY_LIMIT / 2;
    for (let i = 0; i < mitad; i++) expect(admitirIntentoDeCorreo(YO, T0)).toBe(true);
    for (let i = 0; i < mitad; i++) expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS / 2)).toBe(true);
    expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS - 1)).toBe(false);
    // The first half leaves at T0 + window: exactly that many come back.
    for (let i = 0; i < mitad; i++) expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS), `vuelta ${i + 1}`).toBe(true);
    expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS)).toBe(false);
  });

  it("does not count a refused attempt, so refusing extends nothing", () => {
    for (let i = 0; i < EMAIL_CODE_VERIFY_LIMIT; i++) admitirIntentoDeCorreo(YO, T0);
    for (let i = 0; i < 50; i++) expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS - 1)).toBe(false);
    // All twenty admitted ones leave together at T0 + window; the fifty refusals left nothing behind.
    for (let i = 0; i < EMAIL_CODE_VERIFY_LIMIT; i++) expect(admitirIntentoDeCorreo(YO, T0 + LOGIN_WINDOW_MS)).toBe(true);
  });

  it("forgets an account on demand", () => {
    for (let i = 0; i <= EMAIL_CODE_VERIFY_LIMIT; i++) admitirIntentoDeCorreo(YO, T0 + i);
    olvidarIntentosDeCorreo(YO);
    expect(admitirIntentoDeCorreo(YO, T0)).toBe(true);
  });
});
