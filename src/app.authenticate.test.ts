// The one test in this task that goes through the real thing.
//
// `authenticate.test.ts` calls the middleware directly with a hand-built `req`,
// which is fast but trusts that the fake `req.cookies` looks like what
// `cookie-parser` actually produces. It does not: `cookie-parser` runs its own
// `JSONCookies` step on every request, turning a raw value like `j:1` into the
// number `1` before anything downstream ever sees it. A unit test with a fake
// `req` cannot catch that mismatch — only a request that goes through the real
// middleware stack can.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";
import { SESSION_COOKIE_NAME } from "./auth/sessionCookie.js";

describe("authenticate, through the real middleware stack", () => {
  it("refuses a protected route with no credential at all", async () => {
    const res = await request(app).get("/api/ciudad");
    expect(res.status).toBe(401);
  });

  it("refuses, rather than 500s, a cookie cookie-parser has parsed as JSON", async () => {
    // `Cookie: osefi_session=j:1` — cookie-parser hands the route a number, not
    // a string. Before the `typeof` guard in `readSessionCookie`, this reached
    // `hashSessionToken`'s `createHash(...).update()` and threw, turning any
    // unauthenticated request carrying this into a 500 instead of a 401, on
    // every one of the API's protected routes.
    const res = await request(app)
      .get("/api/ciudad")
      .set("Cookie", `${SESSION_COOKIE_NAME}=j:1`);
    expect(res.status).toBe(401);
  });
});
