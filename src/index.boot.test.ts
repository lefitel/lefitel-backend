// What the process refuses to start without.
//
// These are the variables whose absence is silent: the server comes up, serves
// requests, and is wrong. A crash at boot is the only failure mode anyone
// notices.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredEnv, cookieNameCarriesHostPrefix } from "./config/security.js";

const here = dirname(fileURLToPath(import.meta.url));

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

  it("names the MFA keyring pointer as required in production", () => {
    // Without a usable key the TOTP secret can be written and never read back.
    // This half only proves the variable was set; `index.ts` runs the value
    // check, where `llaveActiva()` resolves the pointer and throws by name if
    // it names a key that is absent or malformed. Same split as COOKIE_NAME
    // below.
    expect(requiredEnv("production")).toContain("MFA_ENCRYPTION_KEY_ACTIVE");
    expect(requiredEnv("development")).not.toContain("MFA_ENCRYPTION_KEY_ACTIVE");
  });

  it("never requires a specific key version, because rotation removes them", () => {
    // 🔴 The regression this exists to stop, and it was written the wrong way
    // first. Requiring `MFA_ENCRYPTION_KEY_1` reads as the safe, obvious thing
    // and contradicts the rotation procedure in
    // docs/plans/2026-09-01-factores-mfa.md, whose final step removes exactly
    // that variable — so a rotation carried out perfectly would refuse the next
    // production boot, with every key it actually needs present.
    //
    // The loop rather than one assertion: `_2` is the version a first rotation
    // creates, and pinning only `_1` would let the same mistake back in one
    // number along.
    for (const version of [1, 2, 3]) {
      expect(requiredEnv("production"), `versión ${version}`).not.toContain(
        `MFA_ENCRYPTION_KEY_${version}`,
      );
    }
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

// `index.ts`'s `main()` is not exported and genuinely boots a server —
// connects to Postgres, starts `app.listen` — so it is not something a unit
// test can call directly (and `vitest.config.ts`'s own coverage config
// excludes this file for the same reason: it is the boot sequence, not a
// unit). What can be tested without booting anything is that the source
// actually wires in `auth/mfaKeyCheck.ts`'s check, and — the part that
// matters, Decision 2 of `docs/plans/2026-09-01-factores-mfa.md` — that a
// failed check's own branch never calls `die()` or `process.exit`. This is
// the same source-level approach `controllers/logShape.test.ts` and
// `controllers/requestShape.test.ts` already take for a rule that is
// otherwise only checkable by reading the file yourself.
describe("the MFA key check at boot", () => {
  const indexSrc = readFileSync(resolve(here, "index.ts"), "utf8");

  it("calls comprobarLlaveAlArrancar during boot", () => {
    // `(` included in the needle so this matches the call site and not the
    // `import { comprobarLlaveAlArrancar } from ...` line above it, which
    // names the same identifier without invoking it.
    expect(indexSrc).toMatch(/comprobarLlaveAlArrancar\s*\(/);
  });

  it("a failed key check logs fatal but never stops the process", () => {
    // Walks the braces of the `if (!comprobacionMfa.ok) { ... }` block that
    // follows the call — the same brace-depth approach `logShape.test.ts`
    // uses to find one call's whole argument — rather than a single regex
    // over the entire file, which would just as happily match a `die()` or
    // `process.exit()` three screens away that has nothing to do with this
    // check, and pass this test for the wrong reason.
    const marcador = indexSrc.indexOf("comprobarLlaveAlArrancar(");
    expect(marcador).toBeGreaterThan(-1);

    const abre = indexSrc.indexOf("{", marcador);
    expect(abre).toBeGreaterThan(-1);

    let profundidad = 0;
    let cierre = -1;
    for (let i = abre; i < indexSrc.length; i++) {
      if (indexSrc[i] === "{") profundidad++;
      if (indexSrc[i] === "}") {
        profundidad--;
        if (profundidad === 0) {
          cierre = i;
          break;
        }
      }
    }
    expect(cierre).toBeGreaterThan(abre);

    const bloque = indexSrc.slice(abre, cierre + 1);
    // Sanity check on the walker itself, same reason as
    // `mfaKeyCheck.test.ts`'s "the graph is not suspiciously empty": if this
    // ever comes back not matching `bootLog.fatal`, the two assertions below
    // would pass on an empty or wrong slice for the wrong reason.
    expect(bloque).toMatch(/bootLog\.fatal/);
    expect(bloque).not.toMatch(/process\.exit/);
    expect(bloque).not.toMatch(/\bdie\(/);
  });
});
