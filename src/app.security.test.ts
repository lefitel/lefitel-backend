// The headers a browser needs to see, and the one it must not.
//
// `helmet` defaults are right for a server that serves HTML. This one serves
// JSON and photographs to a page hosted somewhere else, so two of the defaults
// have to be overridden — and getting one of them wrong breaks every image in
// the application, silently, only in the browser.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";
import { allowedOrigins, CSRF_CLIENT_HEADER, HSTS_MAX_AGE_SECONDS } from "./config/security.js";
import { SESSION_COOKIE_NAME } from "./auth/sessionCookie.js";

/**
 * The three header names shared with the other repository, written out by hand.
 *
 * Every assertion about a name below reads one of these and never
 * `ROLE_HEADER`, `SESSION_EXPIRES_HEADER` or `CSRF_CLIENT_HEADER`, and that is
 * the whole point of the three lines. An expectation built from the same
 * constant the code reads moves with the constant: renaming `ROLE_HEADER` to
 * anything at all used to leave all 748 of this project's tests and all 273 of
 * the frontend's green, while in production the browser silently stopped
 * noticing role changes — and renaming `CSRF_CLIENT_HEADER` left them equally
 * green while every write in the ERP answered 403. That is not a gap in
 * coverage, it is the wrong kind of assertion: it catches a *deletion* and
 * cannot catch a *rename*.
 *
 * These names are a wire format between two separately deployed repositories,
 * and the frontend already hard-codes its side (`web/src/api/http.ts`,
 * `web/src/context/SesionProvider.tsx`). A literal on each side is therefore
 * exactly right, and this file is the half that was missing.
 *
 * `CSRF_CLIENT_HEADER` is still imported, for one assertion at the bottom that
 * compares it against `CABECERA_CLIENTE` on purpose — that comparison is the
 * pin, not a duplicate of it.
 *
 * This is the `x-new-token` failure over again, in a smaller shape: the
 * comment on the `exposedHeaders` assertion below explains very well why
 * `supertest` cannot see the effect of that list, and nobody noticed the same
 * blindness applied to the names themselves.
 */
const CABECERA_CLIENTE = "x-osefi-client";
const CABECERA_ROL = "x-osefi-role";
const CABECERA_VENCIMIENTO = "x-osefi-session-expires";

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
    // The literal, not the constant that was just sent as the request header:
    // `cors()` reflects whatever `Access-Control-Request-Headers` asked for, so
    // an expectation written from the same constant as the request proves only
    // that reflection works. Written out, it also proves the name is the one
    // the frontend actually sends.
    expect(res.headers["access-control-allow-headers"]).toContain(CABECERA_CLIENTE);
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
      ["Content-Disposition", CABECERA_ROL, CABECERA_VENCIMIENTO].join(","),
    );
  });

  it("pins the name of the header a cookie-authenticated write has to carry", async () => {
    // The assertion the `exposedHeaders` one above cannot make. Those two are
    // *response* header names, and pinning the string this app emits is enough
    // for them. `CSRF_CLIENT_HEADER` is a **request** header name: nothing this
    // server sends carries it, so the only way to pin it is to make a request
    // that the guard's own reading of the name decides the fate of.
    //
    // A path with no route behind it, on purpose. `requireSameOrigin` is
    // mounted globally, ahead of every router, so the guard runs and then
    // Express answers 404 — no controller, no database, no session lookup.
    // What separates the two outcomes is only whether the guard found the
    // header it was looking for under the name the frontend writes.
    //
    // Rename the constant and this goes 403: the guard demands the new name,
    // the request carries `x-osefi-client`, and every write in the ERP does
    // the same thing in production.
    const COOKIE = `${SESSION_COOKIE_NAME}=un-token-cualquiera`;
    const conCabecera = await request(app)
      .post("/api/no-existe")
      .set("Cookie", COOKIE)
      .set("Origin", ORIGEN as string)
      .set(CABECERA_CLIENTE, "web");
    expect(conCabecera.status, "el guardián no encontró la cabecera con este nombre").toBe(404);

    // And the other half, so the 404 above is not simply what this path
    // answers to everything: the same request without that one header is
    // refused before it gets there.
    const sinCabecera = await request(app)
      .post("/api/no-existe")
      .set("Cookie", COOKIE)
      .set("Origin", ORIGEN as string);
    expect(sinCabecera.status).toBe(403);
  });

  it("keeps that name the exact string the frontend hard-codes", () => {
    // The blunt version of the test above, kept beside it for the sake of the
    // failure message. A rename shows up there as "expected 403 to be 404",
    // which is a puzzle; here it reads "expected 'x-algo-nuevo' to be
    // 'x-osefi-client'", which says what happened and what has to happen next:
    // change `web/src/api/http.ts` in the same breath, or do not rename it.
    expect(CSRF_CLIENT_HEADER).toBe(CABECERA_CLIENTE);
  });

  it("lets another origin load the photographs", async () => {
    // helmet's default is `same-origin`, which would make every <img> in the
    // application fail: the page is served from www.osefi.net and the files
    // from api.osefi.net. Nothing on the server would report an error.
    const res = await request(app).get("/api/login");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
