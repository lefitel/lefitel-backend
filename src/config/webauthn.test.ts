// The two passkey settings, and the three ways of getting them wrong that a
// deployment would not notice until credentials were already registered.
//
// All three functions under test are pure and take their environment as
// arguments, so this file does not have `config/security.ts`'s usual problem
// of pinning whichever environment the runner happened to start in.

import { describe, expect, it } from "vitest";
import {
  requiredEnv,
  webauthnRpId,
  webauthnOrigins,
  allowedOrigins,
  DEV_WEBAUTHN_RP_ID,
  DEV_FRONTEND_ORIGIN,
} from "./security.js";

describe("the Relying Party id has no production default", () => {
  // 🔴 The failure this prevents is the only one on `requiredEnv`'s list that
  // cannot be undone. If this function invented a value — the request's own
  // `Host`, the CORS origin, a literal — production would boot, people would
  // register passkeys against it, and correcting it later would destroy every
  // one of them. An empty string here is what makes the boot check the only
  // thing standing between the two, so it has to stay empty.
  it("returns nothing for production when the variable is unset", () => {
    expect(webauthnRpId(undefined, "production")).toBe("");
    expect(webauthnRpId("", "production")).toBe("");
    expect(webauthnRpId("   ", "production")).toBe("");
  });

  // The same question `allowedOrigins` had to be rewritten to ask: not "is
  // this *not* production?" — which an unset, misspelled or merely unfamiliar
  // `NODE_ENV` all answer "yes" to — but "is this *known* to be
  // development?". A deployment whose NODE_ENV never got set must not quietly
  // inherit localhost.
  it("only falls back to localhost for an environment that says it is development", () => {
    expect(webauthnRpId(undefined, "development")).toBe(DEV_WEBAUTHN_RP_ID);
    expect(webauthnRpId(undefined, undefined)).toBe("");
    expect(webauthnRpId(undefined, "staging")).toBe("");
    expect(webauthnRpId(undefined, "produccion")).toBe("");
  });

  it("an explicit value always wins", () => {
    expect(webauthnRpId("www.osefi.net", "production")).toBe("www.osefi.net");
    expect(webauthnRpId("  www.osefi.net  ", "development")).toBe("www.osefi.net");
  });
});

describe("the origin list is membership, never a prefix or a suffix", () => {
  // 🔴 The attack the `Set` exists to refuse, and the reason `csrf.ts` was
  // rewritten the same way: a check written as "ends with osefi.net" accepts
  // `https://evil-osefi.net`, and one written as "starts with" accepts
  // `https://www.osefi.net.evil.com`. Here that is not a CSRF refusal — it is
  // an authentication decision.
  const origenes = webauthnOrigins("https://www.osefi.net", "production");

  it("accepts the exact origin and nothing shaped like it", () => {
    expect(origenes.has("https://www.osefi.net")).toBe(true);
    expect(origenes.has("https://www.osefi.net.evil.com")).toBe(false);
    expect(origenes.has("https://evil-osefi.net")).toBe(false);
    expect(origenes.has("https://osefi.net")).toBe(false);
    expect(origenes.has("http://www.osefi.net")).toBe(false);
  });

  // A browser never reports an origin with a trailing slash, so a value
  // written `https://www.osefi.net/` would match nothing and every ceremony
  // would fail with no server-side explanation at all. Trimming the input is
  // not the same as loosening the comparison, which stays exact above.
  it("forgives a trailing slash in the configured value, which is a typo", () => {
    expect(webauthnOrigins("https://www.osefi.net/", "production").has("https://www.osefi.net")).toBe(
      true,
    );
  });

  it("takes a comma-separated list and drops blanks and wildcards", () => {
    const varios = webauthnOrigins("https://www.osefi.net, , *, https://otro.osefi.net", "production");
    expect([...varios].sort()).toEqual(["https://otro.osefi.net", "https://www.osefi.net"]);
  });

  it("refuses everything for a production process that was never told", () => {
    expect(webauthnOrigins(undefined, "production").size).toBe(0);
    expect(webauthnOrigins(undefined, undefined).size).toBe(0);
    expect(webauthnOrigins(undefined, "development")).toEqual(new Set([DEV_FRONTEND_ORIGIN]));
  });
});

describe("the passkey origins are not the CORS origins", () => {
  // 🔴 The edit this guards against is an ordinary one nobody would route
  // past this file: `CORS_ORIGIN` gains a staging or preview host so the API
  // will answer it. If the two lists were one, that host would silently
  // become a place where anybody's passkey can be used. The lists look
  // identical in production today, which is exactly why the difference needs
  // a test rather than a comment.
  it("adding a host to CORS_ORIGIN does not make it a valid passkey origin", () => {
    const cors = "https://www.osefi.net,https://staging.osefi.net";
    const passkey = "https://www.osefi.net";

    expect(allowedOrigins(cors, "production")).toContain("https://staging.osefi.net");
    expect(webauthnOrigins(passkey, "production").has("https://staging.osefi.net")).toBe(false);
  });
});

describe("both settings are on the production boot check", () => {
  // The list had no test at all before this one, so it could gain or lose an
  // entry in silence. These two matter more than the rest because they are
  // the only entries whose mistake cannot be corrected by setting them right
  // and restarting — every passkey registered under a wrong id is gone.
  it("production refuses to boot without them", () => {
    const exigidas = requiredEnv("production");
    expect(exigidas).toContain("WEBAUTHN_RP_ID");
    expect(exigidas).toContain("WEBAUTHN_ORIGIN");
  });

  it("and nothing is demanded outside production, as before", () => {
    expect(requiredEnv("development")).toEqual([]);
    expect(requiredEnv(undefined)).toEqual([]);
  });
});
