// The headers a browser needs to see, and the one it must not.
//
// `helmet` defaults are right for a server that serves HTML. This one serves
// JSON and photographs to a page hosted somewhere else, so two of the defaults
// have to be overridden — and getting one of them wrong breaks every image in
// the application, silently, only in the browser.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";
import { HSTS_MAX_AGE_SECONDS } from "./config/security.js";

describe("security headers", () => {
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

  it("lets another origin load the photographs", async () => {
    // helmet's default is `same-origin`, which would make every <img> in the
    // application fail: the page is served from www.osefi.net and the files
    // from api.osefi.net. Nothing on the server would report an error.
    const res = await request(app).get("/api/login");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
