// What the process refuses to start without.
//
// These are the variables whose absence is silent: the server comes up, serves
// requests, and is wrong. A crash at boot is the only failure mode anyone
// notices.

import { describe, it, expect } from "vitest";
import { requiredEnv } from "./config/security.js";

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
});
