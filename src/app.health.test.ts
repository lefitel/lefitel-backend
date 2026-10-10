// The address the container's health check asks.
//
// The Dockerfile declares a HEALTHCHECK so that Coolify only switches to a new
// container once it answers — which is what makes "the image migrates itself
// and then serves" safe: a failed migration never starts the server, the check
// never passes, and the previous version keeps serving.
//
// The first version of that check asked for `/`, the photographs mount, and
// counted any HTTP answer as alive. It worked and it was loud: `/` answers 401
// to a request with no session, a 401 is logged as a warning, and the check
// runs every ten seconds — 8,640 `GET / → 401` warnings a day, in the same log
// a real refused request has to be found in. Measured on the first run of the
// image against a copy of production.
//
// So the check has an address of its own: no session, no body, and no line.

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Request } from "express";
import app from "./app.js";
import { isNoise } from "./middleware/httpLogger.js";

describe("GET /api/health", () => {
  it("answers 204 to a request with no session and no origin", async () => {
    // Exactly what the HEALTHCHECK sends: a bare request from inside the
    // container. No cookie, no Origin, no client header.
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("says nothing about the server it is not asked", async () => {
    // It is reachable by anybody, so it carries nothing: not the version, not
    // the environment, not whether the database answered.
    const res = await request(app).get("/api/health");

    expect(res.headers["content-type"]).toBeUndefined();
  });

  it("writes no line in the log, and every other request still does", () => {
    const de = (originalUrl: string) => ({ originalUrl }) as unknown as Request;

    expect(isNoise(de("/api/health"))).toBe(true);
    // Only that exact address. A prefix match would silence a route somebody
    // mounts under it later.
    expect(isNoise(de("/api/health/extra"))).toBe(false);
    expect(isNoise(de("/api/poste"))).toBe(false);
    expect(isNoise(de("/"))).toBe(false);
  });
});
