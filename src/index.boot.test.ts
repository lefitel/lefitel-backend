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

  it("always requires JWT_SECRET", () => {
    expect(requiredEnv("production")).toContain("JWT_SECRET");
    expect(requiredEnv("development")).toContain("JWT_SECRET");
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
