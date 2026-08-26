// The field photographs, and the fact that a file name used to be the whole
// credential.
//
// `express.static(IMAGES_DIR)` was mounted above every `/api/...` router and
// eleven lines above the first `authenticate`, so `GET /1712428860328_210.jpg`
// answered 200 with the image to anybody on the internet. The names are not a
// secret: `upload.controller.ts` writes `${Date.now()}_${originalName}`, and
// the original names in this database are `Imagen1`..`Imagen26`, WhatsApp
// names carrying their own date, and in some rows the pole number itself.
//
// This file exists because the fix is *positional* — the mount has to stay
// below the API routers and behind `authenticate` — and position is exactly
// what a reorder undoes without any test noticing. `routeGuards.test.ts`
// cannot cover it: its walker reads route-level handler names off
// `app._router.stack`, and a path-less `app.use` lands in its `beforeRouter`
// bucket alongside `helmet` and `cors`, where nothing asserts on it. That is
// why the hole survived every guard test this repo has.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";
import { SESSION_COOKIE_NAME } from "./auth/sessionCookie.js";

describe("stored images are behind the session", () => {
  it("refuses a photograph to a caller with no cookie", async () => {
    // The shape of a real stored name, from the database: a millisecond stamp
    // and the camera's own file name.
    const res = await request(app).get("/1712428860328_210.jpg");

    expect(res.status).toBe(401);
  });

  it("never hands the file to a cookie that is not a live session", async () => {
    // Asserted as "not 200" rather than "401" on purpose. A syntactically valid
    // cookie is looked up in `sesiones`, so the status depends on whether a
    // database is reachable — 401 when the row is absent, 500 when nothing
    // answers — and this file deliberately needs neither. What must hold in
    // both worlds is that the bytes never leave: the old mount answered 200
    // here, with no cookie at all.
    const res = await request(app)
      .get("/1712428860328_210.jpg")
      .set("Cookie", `${SESSION_COOKIE_NAME}=no-es-una-sesion`);

    expect(res.status).not.toBe(200);
  });

  it("answers the same 401 whether or not the file exists", async () => {
    // `authenticate` runs before `express.static` gets to look at the disk, so
    // a missing name and a real one are indistinguishable from outside. That is
    // not incidental: the old mount answered 200 for a hit and a clean 404 for
    // a miss, which made the endpoint an oracle for guessing names — and the
    // only unguessable part of a name is a millisecond.
    const conNombreReal = await request(app).get("/1712428860328_210.jpg");
    const conNombreInventado = await request(app).get("/no-existe-este-fichero-jamas.jpg");

    expect(conNombreReal.status).toBe(401);
    expect(conNombreInventado.status).toBe(401);
  });
});

describe("what the images mount must not have broken", () => {
  it("leaves an unknown /api path a 404, not a 401", async () => {
    // The guard skips `/api/...` on purpose. Without it this mount would answer
    // every client typo with "su sesión expiró", which reads as a session bug
    // and sends whoever hit it to log in again.
    const res = await request(app).get("/api/no-existe");

    expect(res.status).toBe(404);
  });

  it("still lets an unauthenticated caller reach the login route", async () => {
    // The reason the mount had to move below the routers instead of being
    // wrapped where it stood: a path-less `app.use(authenticate, ...)` runs for
    // everything underneath it, and `POST /api/login` is the one route that
    // cannot be asked for a session because it is what issues one.
    const res = await request(app).post("/api/login").send({});

    expect(res.status).not.toBe(401);
  });
});
