// An address that does not exist, and what the caller is told about it.
//
// Until this handler, Express's `finalhandler` answered such a request with
// **HTML** — `Cannot GET /api/whatever`, wrapped in a document. Two things
// follow from that, and this file is about both:
//
//   - **Nobody could read it.** Every client module in `web` reads
//     `error.response.data.message`; against an HTML body that is `undefined`,
//     so seventeen call sites fell back to their own generic wording. The task
//     that makes 404s deliberately is D1, the renaming: a browser holding
//     yesterday's bundle asks for an address that moved, and this is the answer
//     it gets. It has to say the address is wrong, not that something failed.
//   - **It echoed the request back.** `Cannot GET /api/<whatever you asked for>`
//     is the caller's own path reflected into the body. Escaped, so not an
//     injection — but it is the one property of this change that a status-code
//     assertion cannot see, and the one a future "let's put the path in the
//     message, it helps debugging" would undo without anything complaining. So
//     it is asserted here.
//
// **What this file deliberately does not test.** A non-API path — a missing
// image — answers 401 rather than 404, because `authenticateArchivos` runs in
// front of the static mount and refuses before the disk is touched. That is not
// an accident to be fixed here: answering 404 for a missing file and 401 for a
// present one would turn the mount into an oracle for guessing photograph names.
// `app.images.test.ts` owns that behaviour and says so. Reaching this handler on
// a non-API path would need a live session and the whole session fixture, and
// would assert somebody else's rule.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";

/** A path nothing will ever mount, distinctive enough to find in a body. */
const INEXISTENTE = "/api/ruta-que-no-existe-zzz";

describe("an address that does not exist", () => {
  it("answers 404 in JSON, not in HTML", async () => {
    const res = await request(app).get(INEXISTENTE);

    expect(res.status).toBe(404);
    // The header and not just the shape of the body: an HTML document is still
    // parsed into *something* by supertest, and `res.body` on a text response is
    // an empty object — which several plausible assertions accept.
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body?.message, "el cuerpo no lleva el mensaje que lee el cliente").toBeTruthy();
  });

  it("says the address is wrong, not that something went wrong", async () => {
    const res = await request(app).get(INEXISTENTE);

    // Reusing the terminal handler's "Ocurrió un error al procesar la petición."
    // would be the easy choice and the wrong one: after this change the client
    // shows the server's sentence, and during a rename window it would send
    // whoever reads the report hunting a server fault that does not exist.
    expect(res.body.message).toMatch(/direcci[óo]n/i);
    expect(res.body.message).not.toMatch(/error/i);
  });

  it("does not reflect the requested path back into the body", async () => {
    const res = await request(app).get(INEXISTENTE);

    // What `finalhandler` used to do. The whole response is checked, not just
    // `message`: a well-meant `{ message, path }` would satisfy an assertion
    // aimed only at the sentence.
    expect(JSON.stringify(res.body)).not.toContain("ruta-que-no-existe-zzz");
  });

  it("answers the same for every method, since none of them exists either", async () => {
    // A write to an unmounted address never reaches this handler with a session:
    // `requireSameOrigin` refuses first, which is its job. Without a session and
    // without an origin, these are the plain case.
    for (const metodo of ["get", "put", "patch", "delete"] as const) {
      const res = await request(app)[metodo](INEXISTENTE);
      expect(res.status, `${metodo} contestó ${res.status}`).toBe(404);
      expect(res.body?.message, metodo).toBeTruthy();
    }
  });
});

describe("what it must not have swallowed", () => {
  it("leaves a mounted route to its own router", async () => {
    // The other direction, and the one that matters: a handler mounted too early
    // would answer 404 for everything and every other test in this repository
    // would still pass, because they assert on routers rather than on the app's
    // tail. A route that exists but has no session answers 401 — that is
    // `authenticate` running, which means the request got past this handler.
    const res = await request(app).get("/api/bitacora/");

    expect(res.status).toBe(401);
  });

  it("leaves a body the parser rejected to the terminal error handler", async () => {
    // A 400 from `express.json()` is thrown, not returned, so it travels the
    // error path — which passes straight through a three-argument middleware.
    // If this handler were ever written with four parameters it would become an
    // error handler, answer 404 here, and stop existing for real 404s.
    const res = await request(app)
      .post(INEXISTENTE)
      .set("Content-Type", "application/json")
      .send("{ esto no es json");

    expect(res.status).toBe(400);
    expect(res.body.message).toBeTruthy();
  });
});
