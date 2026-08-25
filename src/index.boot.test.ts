// What the process refuses to start without.
//
// These are the variables whose absence is silent: the server comes up, serves
// requests, and is wrong. A crash at boot is the only failure mode anyone
// notices.

import { describe, it, expect } from "vitest";
import { requiredEnv, cookieNameCarriesHostPrefix } from "./config/security.js";

describe("required configuration", () => {
  it("names CORS_ORIGIN as required in production", () => {
    expect(requiredEnv("production")).toContain("CORS_ORIGIN");
  });

  it("does not require CORS_ORIGIN outside production", () => {
    // Development falls back to the Vite port. The danger is a *deployment*
    // that forgets it, not a laptop.
    expect(requiredEnv("development")).not.toContain("CORS_ORIGIN");
  });

  it("no longer requires JWT_SECRET, in any environment", () => {
    // There is nothing left to sign or verify: the session cookie is the
    // only credential now. Requiring this variable after that would only
    // force every environment to go on holding the weak secret this plan
    // set out to retire — docs/specs/2026-08-21-autenticacion-mfa-design.md
    // §11 is the write-up of why keeping it was the actual danger.
    expect(requiredEnv("production")).not.toContain("JWT_SECRET");
    expect(requiredEnv("development")).not.toContain("JWT_SECRET");
  });

  it("names COOKIE_NAME as required in production", () => {
    // Missing this does not fail loudly on its own — the process boots with
    // a cookie named `osefi_session`, no `__Host-` guarantee, and nothing
    // says so. `cookieNameCarriesHostPrefix` below is the check that catches
    // a *wrong* value; this is what catches an *absent* one.
    expect(requiredEnv("production")).toContain("COOKIE_NAME");
  });

  it("names COOKIE_SECURE as required in production", () => {
    expect(requiredEnv("production")).toContain("COOKIE_SECURE");
  });

  it("names RESEND_API_KEY and MAIL_FROM as required in production", () => {
    // Missing either is silent the same way COOKIE_NAME's absence is: the
    // process boots, and `auth/mailer.ts` quietly answers `{ ok: true }` to
    // every verification and reset email without sending one. See
    // `mailer.ts` for the branch this closes off.
    expect(requiredEnv("production")).toContain("RESEND_API_KEY");
    expect(requiredEnv("production")).toContain("MAIL_FROM");
  });

  it("does not require RESEND_API_KEY or MAIL_FROM outside production", () => {
    // Development runs the same fallback deliberately, so the rest of the
    // auth flow can be built without spending the shared daily quota.
    expect(requiredEnv("development")).not.toContain("RESEND_API_KEY");
    expect(requiredEnv("development")).not.toContain("MAIL_FROM");
  });
});

describe("cookieNameCarriesHostPrefix", () => {
  // A browser only honours `__Host-` byte for byte: the prefix has to start
  // the name, capital H, single leading underscore pair. Test data that is
  // only digits — the trap this project already hit once with UUID casing —
  // would let `__host-x` and `_Host-x` slip through a check that never
  // actually reads the letters, so each of the near-miss spellings below is
  // asserted on its own.
  it("accepts the real prefix when the cookie is Secure", () => {
    expect(cookieNameCarriesHostPrefix("__Host-osefi_session", true)).toBe(true);
  });

  it("rejects a lower-cased prefix, even though it reads the same out loud", () => {
    expect(cookieNameCarriesHostPrefix("__host-osefi_session", true)).toBe(false);
  });

  it("rejects a single leading underscore", () => {
    expect(cookieNameCarriesHostPrefix("_Host-osefi_session", true)).toBe(false);
  });

  it("rejects a name with no prefix at all", () => {
    expect(cookieNameCarriesHostPrefix("osefi_session", true)).toBe(false);
  });

  it("does not demand the prefix when the cookie is not Secure", () => {
    // `Secure` is itself one of the three things `__Host-` requires, so an
    // insecure cookie could never carry the prefix in the first place.
    // Development's plain name is not a violation of anything.
    expect(cookieNameCarriesHostPrefix("osefi_session", false)).toBe(true);
  });
});
