// The headers a browser needs to see, and the one it must not.
//
// `helmet` defaults are right for a server that serves HTML. This one serves
// JSON and photographs to a page hosted somewhere else, so two of the defaults
// have to be overridden — and getting one of them wrong breaks every image in
// the application, silently, only in the browser.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";

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

  it("lets another origin load the photographs", async () => {
    // helmet's default is `same-origin`, which would make every <img> in the
    // application fail: the page is served from www.osefi.net and the files
    // from api.osefi.net. Nothing on the server would report an error.
    const res = await request(app).get("/api/login");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
