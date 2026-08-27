// Who gets in.
//
// One credential: the session cookie. What matters most is what happens when a
// session has been revoked — that is the entire reason this middleware was
// rewritten — and, since this task, what happens to a request that carries an
// `Authorization` header instead. It is refused, because nothing reads it.
//
// A whole `describe` block lived here titled "with the old bearer token, during
// the transition", and its five tests all asserted that a signed JWT with no
// session row behind it got in. They are gone rather than inverted: what they
// pinned was the hole. What replaced them is one test at the bottom of this file
// and two through the real stack — see "the header that no longer opens
// anything" below for which, and why the unit-level one cannot be the tripwire
// on its own.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import type { EstadoSesion } from "../auth/sessionState.js";

/**
 * A signing key for this file, put in the environment on purpose.
 *
 * The one test below that sends an `Authorization` header has to send a token
 * that would really verify — a malformed one answers 401 for the wrong reason
 * and proves nothing at all. `authenticate` no longer reads `JWT_SECRET`, so
 * nothing here depends on the value; what matters is that the token below is
 * signed with the same string a re-added `jwt.verify(token,
 * process.env.JWT_SECRET)` would check it against. Set here rather than read
 * from `.env`, because this file mocks the models and so never loads `dotenv`:
 * `process.env.JWT_SECRET` is genuinely `undefined` in this worker, and signing
 * with `undefined` throws.
 */
process.env.JWT_SECRET = "la-clave-que-el-verificador-usaria";

const findLiveSession = vi.fn();
const touchSession = vi.fn();
const slidingExpiry = vi.fn();
const cappedByCeiling = vi.fn();
const findByPk = vi.fn();
// A fixed, reachable mock — not a fresh `vi.fn()` handed out on every `log(...)`
// call. `authenticate.ts` calls `log("auth")` exactly once at module load, so
// this is the one object every log line in the module goes through, and tests
// can assert on it. A mock that returned a new, unreachable function each call
// would let the touch-failure warning be deleted without any test noticing.
const authWarn = vi.fn();

// `slidingExpiry`'s own arithmetic — the idle window, the absolute cap, the
// boundary between them — is `sessionStore.test.ts`'s job, against the real
// function. Here it is mocked like `touchSession`: what this file is
// responsible for proving is that `authenticate` calls it with the right
// arguments and puts its answer, verbatim, on the cookie it reissues.
vi.mock("../auth/sessionStore.js", () => ({
  findLiveSession: (...a: unknown[]) => findLiveSession(...a),
  touchSession: (...a: unknown[]) => touchSession(...a),
  slidingExpiry: (...a: unknown[]) => slidingExpiry(...a),
  cappedByCeiling: (...a: unknown[]) => cappedByCeiling(...a),
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => findByPk(...a) },
}));
// `jsonwebtoken` is deliberately **not** mocked, and the absence is a tripwire
// rather than an omission — the same one `auth/credentials.test.ts` and
// `controllers/login.session.test.ts` carry. There was a `vi.mock` here
// returning a fake `verify`, and while it existed a re-added bearer path would
// have run against a stub that answers whatever the last test told it to. With
// the real library in place, a re-added `jwt.verify` verifies for real.

vi.mock("../utils/logger.js", () => ({ log: () => ({ info: vi.fn(), warn: authWarn }) }));

const { authenticate } = await import("./authenticate.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SESSION_TOUCH_THROTTLE_MINUTES, ROLE_HEADER, SESSION_EXPIRES_HEADER } =
  await import("../config/security.js");
// Real, not mocked: this file's whole point from here on is that `authenticate`
// hands the real `puedeAlcanzar` the caller's estado and its own route, and
// reacts to what it says. Mocking `sessionState.js` would only prove
// `authenticate` calls *something*, never that the something is this allowlist.
const { MENSAJE_FACTOR_PENDIENTE } = await import("../auth/sessionState.js");

/**
 * `authorization` sets the header verbatim, and it is still called that rather
 * than `bearer`: the point of every remaining use is that this is an ordinary
 * request header the middleware does not read, not a credential of any kind.
 *
 * `originalUrl` and `path` are independent, on purpose: `authenticate` runs
 * inside routers (see `app.ts`), so a real `req.path` is relative to the
 * mount point and differs from `req.originalUrl`. Defaulting `path` to the
 * same value as `originalUrl` keeps every test that does not care about the
 * distinction realistic without forcing it to say so; the one test that does
 * care overrides both to different strings.
 */
function call(opts: { cookie?: string; authorization?: string; originalUrl?: string; path?: string } = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    cookieCalls: [] as { name: string; value: string; options: Record<string, unknown> }[],
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    sendStatus(c: number) { this.statusCode = c; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      this.cookieCalls.push({ name, value, options });
      return this;
    },
  };
  const req = {
    cookies: opts.cookie ? { [SESSION_COOKIE_NAME]: opts.cookie } : {},
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    ip: "::1",
    originalUrl: opts.originalUrl ?? "/api/recurso",
    path: opts.path ?? opts.originalUrl ?? "/api/recurso",
  } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  return {
    req,
    res: res as unknown as Response,
    next,
    get status() { return res.statusCode; },
    get cookieCalls() { return res.cookieCalls; },
    get headers() { return res.headers; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 2 } });
  touchSession.mockResolvedValue(undefined);
  slidingExpiry.mockReturnValue(new Date(0));
  // Stands in for the real cap the same way `slidingExpiry` above stands in for
  // the real slide: with the thirty-day ceiling still far off, capping a
  // candidate returns the candidate, which is the situation every test here but
  // the two about the cap is in. The arithmetic itself belongs to
  // `sessionStore.test.ts`, against the real function.
  cappedByCeiling.mockImplementation((_createdAt: Date, candidate: Date) => candidate);
});

describe("with a session cookie", () => {
  it("lets a live session through and says who it is", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date(), estado: "completa", mfa_satisfied_at: null });
    const c = call({ cookie: "buen-token" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.req.user).toMatchObject({ id: 7, id_sesion: "s1" });
  });

  it("reads the role from the database, not from anything the client sent", async () => {
    // A demoted person kept their old permissions for up to a week under the
    // old token. The role is re-read on every request for that reason.
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date(), estado: "completa", mfa_satisfied_at: null });
    findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 3 } });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.req.user?.id_rol).toBe(3);
  });

  it("turns a revoked session away", async () => {
    // The whole point of the rewrite. `findLiveSession` returns null for a
    // revoked, expired or over-the-ceiling session.
    findLiveSession.mockResolvedValue(null);
    const c = call({ cookie: "revocado" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });

  it("turns away someone whose account was archived since they logged in", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    findByPk.mockResolvedValue(null);
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });

  describe("a session older than the password it was opened with", () => {
    /**
     * The belt to the braces of explicit revocation.
     *
     * Every path that changes a password today also revokes the sessions —
     * but "today" is the word doing the work: the next path somebody writes
     * will not, and this catches it without that person having to know it
     * exists.
     */
    const conFechas = (creada: Date, cambiada: Date) => {
      findLiveSession.mockResolvedValue({
        id: "s1",
        id_usuario: 7,
        created_at: creada,
        expires_at: new Date(Date.now() + 1e6),
        last_used_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
      });
      findByPk.mockResolvedValue({
        dataValues: { id: 7, id_rol: 2, pass_changed_at: cambiada },
      });
    };

    it("refuses a session opened before the password was last changed", async () => {
      conFechas(new Date("2026-01-01"), new Date("2026-06-01"));
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);

      expect(c.status).toBe(401);
      expect(c.next).not.toHaveBeenCalled();
    });

    it("keeps a session opened after the change", async () => {
      conFechas(new Date("2026-07-01"), new Date("2026-06-01"));
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);

      expect(c.next).toHaveBeenCalled();
    });

    it("keeps a session opened at the very instant of the change", async () => {
      // `<` and not `<=`, and this is the test that pins it. A session opened
      // by the password change itself — if one ever is — carries the same
      // timestamp as the stamp it is being measured against, and refusing it
      // would log somebody out of the session that was just handed to them.
      const instante = new Date("2026-06-01T10:00:00.000Z");
      conFechas(instante, new Date(instante));
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);

      expect(c.next).toHaveBeenCalled();
    });
  });

  describe("touching last_used_at", () => {
    // A pair of tests that only bracket 0 minutes and 60 minutes cannot tell a
    // 5-minute throttle from a 30-second one — both pass either way. The window
    // has to be measured from the real constant, on both sides of it, or a
    // `* 6_000` typo (30s) where `* 60_000` (minutes) belongs sails through
    // green while writing on nearly every request in production.
    const THROTTLE_MS = SESSION_TOUCH_THROTTLE_MINUTES * 60_000;
    const NOW = new Date("2026-01-01T00:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not write while still inside the throttle window", async () => {
      // One report export makes around two thousand sequential requests.
      // Writing on each one is two thousand UPDATEs on one row.
      findLiveSession.mockResolvedValue({
        id: "s1", id_usuario: 7,
        created_at: new Date(NOW.getTime() - 2 * 86_400_000),
        expires_at: new Date(NOW.getTime() + 1e6),
        last_used_at: new Date(NOW.getTime() - (THROTTLE_MS - 1_000)),
        estado: "completa",
        mfa_satisfied_at: null,
      });
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);
      expect(touchSession).not.toHaveBeenCalled();
      // No write means no new expiry either: a `Set-Cookie` on every request
      // is exactly what this throttle exists to avoid.
      expect(c.cookieCalls).toHaveLength(0);
    });

    it("writes the current time, not the session's own stale timestamp, once the window has passed", async () => {
      // `expect.any(Date)` would accept `sesion.last_used_at` re-written as
      // itself — which is exactly the bug that pins the throttle open forever:
      // every later request would see the same "stale" timestamp and touch
      // again, and `expires_at` would stop sliding. The exact value is the
      // point of the test.
      findLiveSession.mockResolvedValue({
        id: "s1", id_usuario: 7,
        created_at: new Date(NOW.getTime() - 2 * 86_400_000),
        expires_at: new Date(NOW.getTime() + 1e6),
        last_used_at: new Date(NOW.getTime() - (THROTTLE_MS + 1_000)),
        estado: "completa",
        mfa_satisfied_at: null,
      });
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);
      // Three arguments, and the third is not decoration: `touchSession`
      // derives the expiry it writes from `created_at`, which is what stops it
      // writing a value past the ceiling the way it used to.
      expect(touchSession).toHaveBeenCalledWith("s1", NOW, new Date(NOW.getTime() - 2 * 86_400_000));
    });

    it("reissues the cookie itself once the throttle window has passed", async () => {
      // The database row sliding is worthless if the browser's own copy of
      // the expiry never moves: the whole point of this test. Without a
      // fresh `Set-Cookie` here, the browser drops the cookie seven days
      // after login regardless of how often the row gets touched.
      //
      // `slidingExpiry`'s own arithmetic (idle window, absolute cap, the
      // boundary between the two) is proven against the real function in
      // `sessionStore.test.ts`; this only has to show that `authenticate`
      // asks it the right question and puts its exact answer on the cookie.
      const createdAt = new Date(NOW.getTime() - 2 * 86_400_000);
      const capped = new Date("2099-06-01T00:00:00.000Z");
      slidingExpiry.mockReturnValue(capped);
      findLiveSession.mockResolvedValue({
        id: "s1", id_usuario: 7,
        created_at: createdAt,
        expires_at: new Date(NOW.getTime() + 1e6),
        last_used_at: new Date(NOW.getTime() - (THROTTLE_MS + 1_000)),
        estado: "completa",
        mfa_satisfied_at: null,
      });
      const c = call({ cookie: "el-token" });
      await authenticate(c.req, c.res, c.next);

      expect(slidingExpiry).toHaveBeenCalledWith(createdAt, NOW);
      expect(c.cookieCalls).toHaveLength(1);
      expect(c.cookieCalls[0].name).toBe(SESSION_COOKIE_NAME);
      expect(c.cookieCalls[0].value).toBe("el-token");
      expect(c.cookieCalls[0].options.expires).toBe(capped);
      // The same instant on the header and on `req.user`, from the same
      // variable. Three destinations computed separately drift the day one of
      // them is edited; this is what makes them one value.
      expect(c.headers[SESSION_EXPIRES_HEADER]).toBe(capped.toISOString());
      expect(c.req.user?.expires_at).toBe(capped);
    });

    it("reports the window the touch just opened, not the one the row still says", async () => {
      // The failure this replaced, measured on the other side: `req.user` used
      // to carry `sesion.expires_at` — the value read *before* the touch. So
      // somebody returning after a week with ten minutes left on the row was
      // given another seven days by the server and told "ten minutes" by it.
      // Five minutes later their browser warned them, five after that it logged
      // them out, and the session was alive the whole time — taking whatever
      // form they had open with it. The error is bounded by how long they
      // stayed away, not by the throttle.
      const nuevo = new Date("2026-01-08T00:00:00.000Z");
      slidingExpiry.mockReturnValue(nuevo);
      findLiveSession.mockResolvedValue({
        id: "s1", id_usuario: 7,
        created_at: new Date(NOW.getTime() - 2 * 86_400_000),
        expires_at: new Date(NOW.getTime() + 10 * 60_000),
        last_used_at: new Date(NOW.getTime() - (THROTTLE_MS + 1_000)),
        estado: "completa",
        mfa_satisfied_at: null,
      });
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);

      expect(c.headers[SESSION_EXPIRES_HEADER]).toBe(nuevo.toISOString());
      expect(c.req.user?.expires_at).toBe(nuevo);
      // And the row's own value is never what is reported, even though it is
      // the one `findLiveSession` handed over.
      expect(c.headers[SESSION_EXPIRES_HEADER]).not.toBe(
        new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      );
    });

    it("caps the row's own expiry against the ceiling when nothing is touched", async () => {
      // Inside the throttle the row keeps the `expires_at` it already has, and
      // that value cannot be passed on as it stands: `touchSession` wrote it
      // without a ceiling until this change, so rows from before the deploy
      // claim up to a week more than `findLiveSession` will honour. The cap is
      // the same rule the query enforces, applied on the way out.
      const createdAt = new Date(NOW.getTime() - 29 * 86_400_000);
      const filaDice = new Date(NOW.getTime() + 5 * 86_400_000);
      const techo = new Date(NOW.getTime() + 86_400_000);
      cappedByCeiling.mockReturnValue(techo);
      findLiveSession.mockResolvedValue({
        id: "s1", id_usuario: 7,
        created_at: createdAt,
        expires_at: filaDice,
        last_used_at: new Date(NOW.getTime() - 1_000),
        estado: "completa",
        mfa_satisfied_at: null,
      });
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);

      expect(touchSession).not.toHaveBeenCalled();
      expect(cappedByCeiling).toHaveBeenCalledWith(createdAt, filaDice);
      expect(c.headers[SESSION_EXPIRES_HEADER]).toBe(techo.toISOString());
      expect(c.req.user?.expires_at).toBe(techo);
    });
  });

  it("logs the touch failure instead of leaving it unhandled", async () => {
    // `touchSession(...).catch(...)` is fire-and-forget on purpose — the
    // request must not wait on a write nobody asked for — but that is exactly
    // what makes a missing `.catch` dangerous: `src/index.ts` treats any
    // unhandled rejection as fatal and restarts the whole process, so one
    // failed UPDATE under an exhausted pool would take the API down instead of
    // producing one warning line.
    findLiveSession.mockResolvedValue({
      id: "s1", id_usuario: 7,
      created_at: new Date(Date.now() - 2 * 86_400_000),
      expires_at: new Date(Date.now() + 1e6),
      last_used_at: new Date(Date.now() - 60 * 60 * 1000),
      estado: "completa",
      mfa_satisfied_at: null,
    });
    touchSession.mockRejectedValue(new Error("pool agotado"));
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    await vi.waitFor(() => expect(authWarn).toHaveBeenCalled());
  });

  it("stays a failure when the cookie fails, whatever else the request carries", async () => {
    // A cookie that fails is a failure, and this used to be the test that no
    // fallback happened: it asserted `jwt.verify` was never reached, because
    // falling back would have let anyone who could forge a JWT bypass revocation
    // by sending a broken cookie alongside it. There is nothing left to fall back
    // to, so what it pins now is that a second credential cannot be smuggled in
    // by the request itself — the answer to a dead cookie is 401 and no second
    // lookup of any kind, whatever headers came with it.
    findLiveSession.mockResolvedValue(null);
    const c = call({ cookie: "revocado", authorization: "Bearer un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
    // `findLiveSession` ran once, for the cookie. Nothing looked up a user, which
    // is what any second path would have to do to let somebody in.
    expect(findLiveSession).toHaveBeenCalledTimes(1);
    expect(findByPk).not.toHaveBeenCalled();
  });
});

describe("what a session's state may reach", () => {
  // The cut this whole plan exists for. Until this block, `authenticate`
  // answered one question — is this cookie a live session — and a row
  // written the instant a password was accepted was indistinguishable from
  // one that had proved a second factor. `puedeAlcanzar` and
  // `MENSAJE_FACTOR_PENDIENTE` are Task 4's; this proves `authenticate`
  // actually reads their answer instead of merely having imported them.

  /** A live session row shaped like `findLiveSession`'s real return, minus what each test overrides. */
  const sesionCon = (estado: EstadoSesion, extra: Record<string, unknown> = {}) => ({
    id: "s1",
    id_usuario: 7,
    created_at: new Date(Date.now() - 1e6),
    expires_at: new Date(Date.now() + 1e6),
    last_used_at: new Date(),
    estado,
    mfa_satisfied_at: null,
    ...extra,
  });

  it("refuses the ERP to a partial session", async () => {
    // The assertion that makes MFA real. A session that has shown a password
    // and nothing else must not read a single row of the business data.
    findLiveSession.mockResolvedValue(sesionCon("parcial"));
    const c = call({ cookie: "t", originalUrl: "/api/usuario" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });

  it("lets a partial session finish logging in", async () => {
    findLiveSession.mockResolvedValue(sesionCon("parcial"));
    const c = call({ cookie: "t", originalUrl: "/api/auth/mfa/verify" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
  });

  it("answers 403 and not 401 to an onboarding session reaching the ERP", async () => {
    // The difference is what the frontend does with it: a 401 ends the
    // session and sends somebody back to the login they just completed,
    // which is a loop. A 403 keeps them inside, where the screen that
    // finishes their setup is.
    findLiveSession.mockResolvedValue(sesionCon("onboarding"));
    const c = call({ cookie: "t", originalUrl: "/api/usuario" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(403);
    expect((c.res as unknown as { body: { message: string } }).body).toEqual({
      message: MENSAJE_FACTOR_PENDIENTE,
    });
    expect(c.next).not.toHaveBeenCalled();
  });

  it("puts the state on req.user, for the step-up gate to read", async () => {
    findLiveSession.mockResolvedValue(sesionCon("onboarding", { mfa_satisfied_at: null }));
    const c = call({ cookie: "t", originalUrl: "/api/auth/email/send" });
    await authenticate(c.req, c.res, c.next);

    expect(c.req.user).toMatchObject({ estado: "onboarding", mfa_satisfied_at: null });
  });

  it("reads the path off originalUrl, not off req.path", async () => {
    // The real values, not invented ones: `auth.routes.ts` mounts
    // `authenticate` per-route on a router hung at `/api/auth`
    // (`router.get("/me", authenticate, me)`), so a real request to
    // `GET /api/auth/me` carries `req.originalUrl === "/api/auth/me"` and
    // `req.path === "/me"` — relative to that mount.
    //
    // A test that picks a route the allowlist refuses either way would pass
    // whichever field the code reads, and prove nothing — which is exactly
    // the shape of test the brief warns is worthless here. `/api/auth/me` is
    // the opposite case: it is in `parcial`'s allowlist by its real, full
    // path, and refused by the bare `/me` a mount-relative read would
    // produce (nothing in the allowlist is `/me` or starts with `/me/`).
    // Reading `originalUrl` calls `next()`; reading `req.path` would answer
    // 401 instead, for a request `parcial` is supposed to be allowed to make.
    findLiveSession.mockResolvedValue(sesionCon("parcial"));
    const c = call({ cookie: "t", originalUrl: "/api/auth/me", path: "/me" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.status).toBe(0);
  });

  it("does not set the role header on a request the state check refuses", async () => {
    // Where the check goes matters: after `usuario` is resolved (so the
    // account-archived path is untouched) but before any response header is
    // written. A refused request carrying `ROLE_HEADER` would tell a caller
    // who did not pass the gate what role they have.
    findLiveSession.mockResolvedValue(sesionCon("parcial"));
    const c = call({ cookie: "t", originalUrl: "/api/usuario" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(401);
    expect(c.headers[ROLE_HEADER]).toBeUndefined();
    expect(c.headers[SESSION_EXPIRES_HEADER]).toBeUndefined();
  });

  it("still lets a complete session through unchanged", async () => {
    // `puedeAlcanzar("completa", ...)` is always true — the gate this task
    // adds must not narrow what a fully authenticated session could already
    // reach.
    findLiveSession.mockResolvedValue(sesionCon("completa"));
    const c = call({ cookie: "t", originalUrl: "/api/usuario" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.status).toBe(0);
  });
});

describe("the current-role header", () => {
  // Task 2's whole point: the frontend used to notice a role change by
  // decoding `id_rol` out of a re-signed JWT (`x-new-token`, now dead — see
  // `app.ts`). This header replaces that mechanism, and it has to come from the
  // database or a demoted account keeps its old buttons for as long as its
  // credential lives — precisely the defect the rest of this file exists to
  // close for `req.user.id_rol`. There was a second test here, for the same
  // header on the bearer path: the mechanism had to work on both credentials or
  // it warned only half the users through the transition. There is one
  // credential now.

  it("is set on the cookie path, from the database", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date(), estado: "completa", mfa_satisfied_at: null });
    findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 4 } });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);

    expect(c.headers[ROLE_HEADER]).toBe("4");
  });

});

describe("with nothing at all", () => {
  it("is 401, not 403", async () => {
    // The client uses the difference to decide whether to end the session. A
    // 403 over one resource must not throw somebody out of the application.
    const c = call();
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });
});

describe("the header that no longer opens anything", () => {
  /**
   * The test this whole plan was for, at the level the code lives on.
   *
   * The token is **signed for real**, with the key a re-added verifier would
   * check it against (see the top of this file). That is the difference between
   * this test and a test that proves nothing: `Bearer no-es-un-jwt` would answer
   * 401 for being malformed, and would go on answering 401 with the old path
   * fully restored. A token that verifies makes the 401 mean "nothing read this
   * header", which is the claim.
   *
   * **This one alone is not the tripwire, and saying so is the point.** Bring
   * the bearer branch back and it would call `jwt.verify(token,
   * process.env.JWT_SECRET)` — the value this file sets itself, so verification
   * succeeds, `findByPk` answers with the user from the top-level `beforeEach`,
   * and `next()` runs: this test goes red. But it goes red only because the key
   * lines up, and a future edit that moves the secret out of this file would
   * quietly turn it back into a test of nothing. The two that cannot be
   * defeated that way go through the real Express stack with the real
   * configured key: "an Authorization header opens nothing" in
   * `app.auth.test.ts`, and "leaves nothing open on a real route" in
   * `csrf.test.ts`.
   */
  it("refuses a properly signed token when there is no cookie", async () => {
    const token = jwt.sign({ id: 7, id_rol: 1 }, process.env.JWT_SECRET as string);
    // Signed, not merely long: verifying it here is what stops this test from
    // passing on a string that could never have got in anyway.
    expect(jwt.verify(token, process.env.JWT_SECRET as string)).toMatchObject({ id: 7 });

    const c = call({ authorization: `Bearer ${token}` });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
    expect(c.req.user).toBeUndefined();
    // Nothing was looked up, which is the shape of "no credential was read"
    // rather than "a credential was read and rejected". The two are worth
    // separating even here: on the real app, with no account behind the token,
    // a restored bearer path answers 401 as well — with the other of this
    // middleware's two sentences. See `csrf.test.ts` for the version of this
    // test that got caught by exactly that.
    expect(findLiveSession).not.toHaveBeenCalled();
    expect(findByPk).not.toHaveBeenCalled();
    expect((c.res as unknown as { body: { message: string } }).body.message)
      .toBe("Su sesión expiró. Vuelva a iniciar sesión.");
  });

  it("does not leak the role header to a caller it refused", async () => {
    // `ROLE_HEADER` used to be set on the bearer path too, from the database.
    // A refused request must not carry it: it is a fact about an authenticated
    // caller, and this one is not authenticated.
    const token = jwt.sign({ id: 7, id_rol: 1 }, process.env.JWT_SECRET as string);
    const c = call({ authorization: `Bearer ${token}` });
    await authenticate(c.req, c.res, c.next);

    expect(c.headers[ROLE_HEADER]).toBeUndefined();
    expect(c.headers[SESSION_EXPIRES_HEADER]).toBeUndefined();
  });
});

describe("when the backend itself is unwell", () => {
  // The plan's own review of this middleware found the gap: `authenticate` was
  // written `async`, and in Express 4 an `async` middleware that rejects never
  // reaches the error handler — the request just hangs until the client gives
  // up. That risk sits on *every* protected route, so any unhandled rejection
  // here would freeze the whole API instead of answering with a 500.
  it("answers 500 instead of hanging when the session lookup throws", async () => {
    findLiveSession.mockRejectedValue(new Error("pool agotado"));
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(500);
    expect(c.next).not.toHaveBeenCalled();
  });

  it("answers 500 instead of hanging when the user lookup throws, cookie path", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    findByPk.mockRejectedValue(new Error("pool agotado"));
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(500);
    expect(c.next).not.toHaveBeenCalled();
  });
});
