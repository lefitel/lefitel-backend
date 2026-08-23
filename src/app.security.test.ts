// The headers a browser needs to see, and the one it must not.
//
// `helmet` defaults are right for a server that serves HTML. This one serves
// JSON and photographs to a page hosted somewhere else, so two of the defaults
// have to be overridden — and getting one of them wrong breaks every image in
// the application, silently, only in the browser.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";
import { allowedOrigins, CSRF_CLIENT_HEADER, HSTS_MAX_AGE_SECONDS, ROLE_HEADER } from "./config/security.js";

describe("security headers", () => {
  // The origin this process is really configured with, read the way `app.ts`
  // reads it instead of written out: these assertions are about the wiring, and a
  // literal here would only prove the literal.
  const ORIGEN = allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0];

  it("does not announce what it is running", async () => {
    const res = await request(app).get("/api/login");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("refuses to be framed", async () => {
    const res = await request(app).get("/api/login");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("does not sniff content types", async () => {
    const res = await request(app).get("/api/login");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("tells the browser never to come back over plain HTTP", async () => {
    // Nothing asserted this header at all, so the whole option could go missing
    // in a helmet upgrade — or `maxAge` be misspelled, which silently falls back
    // to helmet's own much shorter default — and the tests would stay green.
    // `includeSubDomains` is the half that is easiest to lose and the half that
    // covers api.osefi.net.
    const res = await request(app).get("/api/login");
    expect(res.headers["strict-transport-security"]).toBe(
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    );
  });

  it("lets the browser keep the session cookie it is sent", async () => {
    // The header the whole cookie depends on, and the one `curl` can never tell
    // you is missing. A browser discards the `Set-Cookie` of a cross-origin
    // response that does not carry this, and www.osefi.net and api.osefi.net are
    // different origins — so without it the login sets a cookie the browser
    // throws away, `authenticate` never sees one, and six tasks of session work
    // are code that cannot run in production. curl applies no CORS at all: it
    // would have answered 200 with a `Set-Cookie` in hand the whole time.
    const res = await request(app).get("/api/login");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("grants our own frontend permission to send its CSRF header", async () => {
    // The preflight, which is the half of the CSRF defence that lives in the
    // browser rather than in our code. A header that is not CORS-safelisted only
    // stops anything if the browser is refused permission to send it — and only
    // helps if our own frontend is granted it.
    const res = await request(app)
      .options("/api/ciudad")
      .set("Origin", ORIGEN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", CSRF_CLIENT_HEADER);

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGEN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-headers"]).toContain(CSRF_CLIENT_HEADER);
  });

  it("refuses that permission to anybody else, including a lookalike domain", async () => {
    // No `Access-Control-Allow-Origin` means the browser never sends the real
    // request, so the header the guard demands can never be attached from here.
    // `evil-osefi.net` is a different registrable domain that ends in the same
    // letters: it is what passes a check written as a suffix match, and it is
    // refused here by the same list the guard uses.
    for (const ajeno of ["https://evil-osefi.net", "https://evil.osefi.net"]) {
      const res = await request(app)
        .options("/api/ciudad")
        .set("Origin", ajeno)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", CSRF_CLIENT_HEADER);

      expect(res.headers["access-control-allow-origin"], ajeno).toBeUndefined();
    }
  });

  it("exposes exactly these response headers — no more, no fewer", async () => {
    // Nothing else in this repository fixes what `exposedHeaders` holds.
    // `toContain` would not catch the realistic failure here, which is
    // someone deleting an entry while editing the array for an unrelated
    // reason — `Content-Disposition` is what lets the frontend read an
    // exported file's real name instead of downloading everything as
    // "download" (see `web/src/api/generador.api.test.ts`'s comment for the
    // failure from the frontend's side), and `ROLE_HEADER` is how the
    // frontend notices a role that changed mid-session: a header can cross
    // the wire and still be invisible to the page's JavaScript if it is not
    // named here, which is the exact way `x-new-token` used to be thrown away
    // before this array existed.
    //
    // Two entries now, not three. `x-new-token` came out when the last thing
    // that emitted it went: nothing signs a per-request JWT any more, so
    // exposing that name only advertised a mechanism that had stopped
    // existing. Equality is also what notices somebody putting it back.
    //
    // And what this test does *not* prove, so nobody reads more into a green
    // run than is there: `supertest` never applies
    // `Access-Control-Expose-Headers`, so a header dropped from this list
    // still arrives in every assertion in this file. The list decides only
    // what a real browser lets the page's JavaScript read — which is why it
    // has to be pinned here rather than caught by any request-level test.
    const res = await request(app).get("/api/login");
    expect(res.headers["access-control-expose-headers"]).toBe(
      ["Content-Disposition", ROLE_HEADER].join(","),
    );
  });

  it("lets another origin load the photographs", async () => {
    // helmet's default is `same-origin`, which would make every <img> in the
    // application fail: the page is served from www.osefi.net and the files
    // from api.osefi.net. Nothing on the server would report an error.
    const res = await request(app).get("/api/login");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
