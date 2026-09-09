// The per-person budgets, one file for the four — B3.
//
// The three the generator used to keep inside its router and the export one
// C3 moved out, now together in `middleware/limiters.ts`. What this file pins
// is each budget's number and its refusal, in isolation. That each one is
// mounted on the routes it exists for — by reference, since a limiter is an
// anonymous function — is `routeGuards.test.ts`; that the six reports and the
// generator's query really draw from one bucket through the real stack is
// `reporte.contract.test.ts`. Three files, three claims, none of them
// pretending to be another.
//
// The numbers are written out by hand. Reading them off the module would only
// prove the code agrees with itself — `routeGuards.test.ts` says why.

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  perUser,
  consultaLimiter,
  rutaLimiter,
  conteoLimiter,
  exportLimiter,
  writeLimiter,
} from "./limiters.js";

const USUARIO = 42;
const CLAVE = `u:${USUARIO}`;

/** An app that is only the budget, so nothing else can explain a failure. */
function probe(cubo: RequestHandler, id: number | undefined = USUARIO) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (id !== undefined) {
      // The key generator only reads `id`; the rest is here because `req.user`
      // requires it, with the values a live session has today.
      req.user = {
        id,
        id_rol: 1,
        id_sesion: "s",
        expires_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
      };
    }
    next();
  });
  app.post("/", cubo, (_req, res) => { res.status(200).json({ ok: true }); });
  return app;
}

/** The five, each with the number and the sentence it was decided with. */
const CUBOS = [
  ["consultas", consultaLimiter, 30, "Demasiadas consultas seguidas. Espere un momento e intente de nuevo."],
  ["comprobaciones", conteoLimiter, 120, "Demasiadas comprobaciones seguidas. Espere un momento."],
  ["exportaciones", exportLimiter, 10, "Demasiadas exportaciones seguidas. Espere un momento e intente de nuevo."],
  ["escrituras", writeLimiter, 60, "Demasiados cambios seguidos. Espere un momento e intente de nuevo."],
  ["trazados", rutaLimiter, 20, "Demasiados trazados seguidos. Espere un momento e intente de nuevo."],
] as const;

beforeEach(async () => {
  for (const [, cubo] of CUBOS) await cubo.resetKey(CLAVE);
});

describe.each(CUBOS)("the budget of %s", (_nombre, cubo, tope, aviso) => {
  it(`lets ${tope} a minute through and refuses the next, in the shape everything reads`, async () => {
    const app = probe(cubo);
    for (let i = 0; i < tope; i++) {
      const res = await request(app).post("/");
      expect(res.status, `la petición ${i + 1} de ${tope} debería pasar`).toBe(200);
      // The number and the window in one string, so a change to either — the
      // limit, or the minute — is a change to this line.
      expect(res.headers["ratelimit-policy"]).toBe(`${tope};w=60`);
      // Draft-6 in particular: draft-7 writes the same policy line and folds
      // the three counters into one `RateLimit` header, which is a change to
      // what a client can read that the line above would not see. And the
      // legacy `X-RateLimit-*` family stays off.
      expect(res.headers["ratelimit-limit"]).toBe(String(tope));
      expect(res.headers["ratelimit-remaining"]).toBe(String(tope - i - 1));
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    }

    const res = await request(app).post("/");

    expect(res.status).toBe(429);
    // `{ message }` is what every failure in this API answers with and what
    // the client reads. Anything else surfaces as an undefined message on screen.
    expect(res.body).toEqual({ message: aviso });
  });
});

describe("the key", () => {
  it("is the account when there is a session, and the address when there is not", () => {
    expect(perUser({ user: { id: USUARIO }, ip: "203.0.113.7" })).toBe("u:42");
    expect(perUser({ ip: "203.0.113.7" })).toBe("ip:203.0.113.7");
  });

  it("folds an IPv6 address into its /56 block", () => {
    // A raw address would be billions of keys for one allocation, and so no
    // budget at all. The block, written out: `5678` becomes `5600::/56`.
    expect(perUser({ ip: "2001:db8:1234:5678::1" })).toBe("ip:2001:db8:1234:5600::/56");
  });

  it("names the shape it must never produce, and where it would", () => {
    // No session and no address: one key for every such caller, which is the
    // one thing a key generator must not do. Unreachable — every mount sits
    // behind `authenticate` — and pinned so that a mount in front of it some
    // day is a conscious choice, not a surprise.
    expect(perUser({})).toBe("ip:");
  });
});

describe("what a budget counts", () => {
  it("counts per account, so one person cannot spend another's", async () => {
    const mio = probe(consultaLimiter, USUARIO);
    for (let i = 0; i < 30; i++) expect((await request(mio).post("/")).status).toBe(200);
    expect((await request(mio).post("/")).status).toBe(429);

    const ajeno = probe(consultaLimiter, USUARIO + 1);
    try {
      expect((await request(ajeno).post("/")).status).toBe(200);
    } finally {
      await consultaLimiter.resetKey(`u:${USUARIO + 1}`);
    }
  });

  it("keeps each budget's count apart: the same key in two of them is two counters", async () => {
    // Sharing is a property of the instance, not of the key — which is what
    // lets one instance be mounted on seven routes, and why a test has to reset
    // the instance it spent. Spending the queries leaves the exports whole.
    const consultas = probe(consultaLimiter);
    for (let i = 0; i < 30; i++) expect((await request(consultas).post("/")).status).toBe(200);
    expect((await request(consultas).post("/")).status).toBe(429);

    expect((await request(probe(exportLimiter)).post("/")).status).toBe(200);
  });
});
