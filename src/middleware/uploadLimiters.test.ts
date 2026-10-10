// A budget on the one write that costs disk.
//
// `POST /api/files/` is deliberately not gated by module — its router explains
// why, and the reason holds: it serves an event photograph, a pole photograph
// and your own portrait, so tying it to one module would either stop a Cliente
// changing their picture or hand a Cliente the right to attach photographs to
// events.
//
// What did not hold is the rest of the sentence. Ungated *and* unmetered means
// any valid session could write to the server's disk at five megabytes a
// request, without limit, from the least-privileged role in the system. The
// orphan sweep in the Archivos screen cleans up files nothing points at, but it
// runs when somebody opens that screen — it is housekeeping, not a brake.
//
// So the endpoint keeps its exemption from the permission matrix and gains a
// budget instead. Per account, because the account is what the session names and
// what an administrator can act on; the IP is only the fallback for a request
// that somehow arrives without one, which `authenticate` already prevents.

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadLimiter, UPLOAD_LIMIT, uploadBucketKey } from "./uploadLimiters.js";

const USUARIO = 42;
const CLAVE = `upload:u:${USUARIO}`;

/** An app that is only the limiter, so nothing else can explain a failure. */
function probe(id: number | undefined = USUARIO) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (id !== undefined) {
      // The limiter only reads `id`; the two session fields are here because
      // `req.user` requires them, with the values a live session has today.
      req.user = {
        id,
        id_rol: 1,
        id_sesion: "s",
        expires_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
        // Required on `req.user`, and null until somebody types their password
        // into `requireStepUp`: the ten-minute window of a factor-less account.
        password_confirmed_at: null,
      };
    }
    next();
  });
  app.post("/", uploadLimiter, (_req, res) => { res.status(200).json({ ok: true }); });
  return app;
}

describe("the upload budget", () => {
  beforeEach(async () => {
    await uploadLimiter.resetKey(CLAVE);
  });

  it("lets an account through up to its limit", async () => {
    const app = probe();
    for (let i = 0; i < UPLOAD_LIMIT; i++) {
      const res = await request(app).post("/");
      expect(res.status, `la subida ${i + 1} de ${UPLOAD_LIMIT} debería pasar`).toBe(200);
    }
  });

  it("refuses the one after that, and says so in the shape everything else uses", async () => {
    const app = probe();
    for (let i = 0; i < UPLOAD_LIMIT; i++) await request(app).post("/");

    const res = await request(app).post("/");

    expect(res.status).toBe(429);
    // `{ message }` is what every failure in this API answers with, and what the
    // client reads. A limiter that answered anything else would surface as an
    // undefined message on screen.
    expect(res.body).toHaveProperty("message");
    expect(typeof res.body.message).toBe("string");
  });

  it("counts per account, so one person cannot spend another's budget", async () => {
    const mio = probe(USUARIO);
    for (let i = 0; i < UPLOAD_LIMIT; i++) await request(mio).post("/");
    expect((await request(mio).post("/")).status).toBe(429);

    const ajeno = probe(USUARIO + 1);
    try {
      expect((await request(ajeno).post("/")).status).toBe(200);
    } finally {
      await uploadLimiter.resetKey(`upload:u:${USUARIO + 1}`);
    }
  });

  it("falls back to the address when there is no session", () => {
    // `authenticate` runs before this in the real app, so the fallback should
    // never be reached — but a key generator that returns undefined puts every
    // anonymous caller in one shared bucket, which is worse than a wrong bucket.
    const sinSesion = { ip: "203.0.113.7" } as Request;
    expect(uploadBucketKey(sinSesion)).toBe("upload:ip:203.0.113.7");

    // Every field `req.user` declares, though the key generator reads `id`
    // alone: `as Request` is a cast, so a fixture short of the session fields
    // compiles and `npm run typecheck` stays quiet about it.
    const conSesion = {
      ip: "203.0.113.7",
      user: {
        id: USUARIO,
        id_rol: 1,
        id_sesion: "s",
        expires_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
        // Required on `req.user`, and null until somebody types their password
        // into `requireStepUp`: the ten-minute window of a factor-less account.
        password_confirmed_at: null,
      },
    } as Request;
    expect(uploadBucketKey(conSesion)).toBe(CLAVE);
  });

  // A limiter that exists and is not mounted is a limiter that does nothing,
  // and every test above would stay green while the endpoint went back to being
  // unmetered. Source-level because the route needs a session to reach through
  // `authenticate`, and standing one up would test the login rather than this.
  it("is mounted on the route it exists for, and on the route rather than the router", () => {
    // D1 folded the upload into `files.routes.ts`, which is why this reads that
    // file now. The move is also what makes the second half of this test worth
    // writing: sharing a router with six other routes, `uploadLimiter` is one
    // careless tidy-up away from becoming `router.use(uploadLimiter)` — and then
    // the thirty requests a minute that exist to ration writing files to disk
    // would be spent by the Archivos screen, which costs three of them every
    // time somebody opens it.
    const here = dirname(fileURLToPath(import.meta.url));
    const fuente = readFileSync(join(here, "..", "routes", "files.routes.ts"), "utf8");
    // Comments stripped before anything is matched. That file warns about the
    // mistake below *in prose*, quoting the very call it forbids, and a source
    // test that reads its own warning as the offence is a test that cannot be
    // written about carefully.
    const router = fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // `router.post("/"` and not `router.post(`: the search used to take whichever
    // POST came first in the file, which was right only while there was one. D1
    // merged three routers into this one; a POST added above the upload would
    // have silently pointed every assertion below at the wrong route.
    const at = router.indexOf('router.post("/"');
    const post = at === -1 ? undefined : router.slice(at, router.indexOf(";", at));

    expect(post, "files.routes.ts ya no declara un POST").toBeDefined();
    expect(
      post,
      `el POST de subida no pasa por uploadLimiter: ${post}`,
    ).toContain("uploadLimiter");
    // Ahead of multer, and that order is the point: `memoryStorage` reads the
    // whole file into memory before any handler runs, so a request already over
    // budget has to be turned away in front of it.
    expect(
      post!.indexOf("uploadLimiter") < post!.indexOf("upload.single"),
      `uploadLimiter va detrás de multer: ${post}`,
    ).toBe(true);
    expect(
      router,
      "uploadLimiter se montó en el router: gastaría el cubo de subida navegando archivos",
    ).not.toMatch(/router\.use\(\s*uploadLimiter/);
  });
});
