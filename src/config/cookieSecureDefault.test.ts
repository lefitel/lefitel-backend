import { describe, it, expect } from "vitest";

/**
 * The default for `COOKIE_SECURE`, and why it is worth a test of its own.
 *
 * This used to be `process.env.COOKIE_SECURE !== "false"` — fail closed,
 * unconditionally. That is the safe-looking version, and it made a fresh
 * checkout impossible to start: with neither cookie variable set,
 * `SESSION_COOKIE_NAME` falls back to a name with no `__Host-` prefix while
 * that expression says `Secure`, and `index.ts` refuses to boot on exactly
 * that pair. What a developer saw was a FATAL line about a cookie prefix they
 * had never configured.
 *
 * It also contradicted `requiredEnv`, which deliberately demands neither
 * variable outside production. Promising "you do not need these in
 * development" and then refusing to start without them is not strictness, it
 * is two halves of the configuration disagreeing with each other.
 *
 * The rule below is the fix, and the asymmetry is the point: an explicit value
 * always wins, and the fallback opens **only** for an environment that has
 * said it is not production. The failure that actually costs something is a
 * production deployment whose `NODE_ENV` is misspelled or missing, and that
 * one still gets `Secure`.
 *
 * Reimplemented here rather than imported because `config/security.ts` reads
 * `process.env` once at module load: importing it would pin whichever
 * environment the test runner happened to start in, and could only ever
 * assert one of the five rows below. The expression is copied verbatim, and
 * the last test in this file is what keeps the copy honest.
 */
const ENTORNOS_SIN_TLS = ["development", "test"];

function secureFor(env: { NODE_ENV?: string; COOKIE_SECURE?: string }): boolean {
  return env.COOKIE_SECURE !== undefined
    ? env.COOKIE_SECURE !== "false"
    : !ENTORNOS_SIN_TLS.includes(env.NODE_ENV ?? "");
}

describe("the COOKIE_SECURE default", () => {
  it("leaves development open, which is the whole reason this changed", () => {
    // `Secure` rules out `http://localhost`, so a development server that
    // sets this cookie `Secure` sets a cookie no browser will send back.
    expect(secureFor({ NODE_ENV: "development" })).toBe(false);
    expect(secureFor({ NODE_ENV: "test" })).toBe(false);
  });

  it("closes for production, and for every environment that did not say", () => {
    expect(secureFor({ NODE_ENV: "production" })).toBe(true);
    // The three that matter more than production itself, because production
    // is already forced to set the variable by `requiredEnv`: these are the
    // ways a real deployment ends up here by accident.
    expect(secureFor({})).toBe(true);
    expect(secureFor({ NODE_ENV: "" })).toBe(true);
    expect(secureFor({ NODE_ENV: "produccion" })).toBe(true);
  });

  it("lets an explicit value win in both directions", () => {
    expect(secureFor({ NODE_ENV: "development", COOKIE_SECURE: "true" })).toBe(true);
    expect(secureFor({ NODE_ENV: "production", COOKIE_SECURE: "false" })).toBe(false);
  });

  it("treats anything that is not the string 'false' as Secure", () => {
    // Including the ones somebody types meaning "off". A typo here has to fail
    // towards the cookie being protected, not away from it.
    for (const puesto of ["FALSE", "False", "0", "no", "", " false "]) {
      expect(secureFor({ NODE_ENV: "production", COOKIE_SECURE: puesto })).toBe(true);
    }
  });

  /**
   * The guard on the copy above. Without it, `security.ts` could be rewritten
   * tomorrow and every assertion here would keep passing while describing a
   * rule the application no longer follows — which is the exact failure this
   * project has been bitten by before.
   */
  it("still matches the expression `config/security.ts` actually uses", async () => {
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync("src/config/security.ts", "utf8");

    expect(
      fuente,
      "SESSION_COOKIE_SECURE ya no se calcula como este test supone: la regla " +
        "cambió en security.ts y este fichero quedó describiendo otra cosa.",
    ).toContain('process.env.COOKIE_SECURE !== undefined');
    expect(fuente).toContain('process.env.COOKIE_SECURE !== "false"');
    expect(fuente).toContain('ENTORNOS_SIN_TLS.includes(process.env.NODE_ENV ?? "")');
    // And that the list itself has not quietly grown a third entry.
    expect(fuente).toContain('const ENTORNOS_SIN_TLS = ["development", "test"]');
  });
});
