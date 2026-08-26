// Which doors each session state opens.
//
// Every assertion here calls `puedeAlcanzar` directly rather than reading
// `sessionState.ts`'s source text: three tasks in this arc's history shipped
// tests that matched a file's contents against a substring, and every one of
// them turned out satisfiable by a doc comment or a slice that covered the
// wrong region. A pure function is tested by calling it.

import { describe, it, expect } from "vitest";
import { puedeAlcanzar } from "./sessionState.js";

describe("what each session state opens", () => {
  it("lets a partial session reach only the doors that can finish the login", () => {
    expect(puedeAlcanzar("parcial", "/api/auth/mfa/verify")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/logout")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/me")).toBe(true);
  });

  it("closes the ERP to a partial session, which is the whole point", () => {
    // The single most important assertion in this plan. Without it the second
    // factor is decorative: the password alone reaches the data.
    expect(puedeAlcanzar("parcial", "/api/usuario")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/poste/1")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/permiso/1")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/auth/totp/setup")).toBe(false);
  });

  it("lets an onboarding session set itself up, and nothing else", () => {
    expect(puedeAlcanzar("onboarding", "/api/auth/email/send")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/totp/setup")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/webauthn/register/options")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/recovery-codes/regenerate")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/usuario")).toBe(false);
  });

  it("opens everything to a complete session", () => {
    expect(puedeAlcanzar("completa", "/api/usuario")).toBe(true);
    expect(puedeAlcanzar("completa", "/api/auth/me")).toBe(true);
  });

  it("matches on whole path segments, not on string prefixes", () => {
    // `/api/auth/mefoo` starts with `/api/auth/me`. A naive startsWith would
    // open any route somebody later mounts under a name that happens to share
    // an allowed prefix.
    expect(puedeAlcanzar("parcial", "/api/auth/mefoo")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/auth/sessions-all")).toBe(false);
  });

  it("ignores the query string", () => {
    expect(puedeAlcanzar("parcial", "/api/auth/me?x=1")).toBe(true);
  });
});
