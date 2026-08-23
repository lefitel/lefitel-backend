// Who gets in.
//
// Two credentials during the transition: the cookie, and the old bearer token.
// The order matters and the fallback matters, but what matters most is what
// happens when a session has been revoked — that is the entire reason this
// middleware is being rewritten.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const findLiveSession = vi.fn();
const touchSession = vi.fn();
const slidingExpiry = vi.fn();
const findByPk = vi.fn();
const jwtVerify = vi.fn();
// Fixed, reachable mocks — not a fresh `vi.fn()` handed out on every `log(...)`
// call. `authenticate.ts` calls `log("auth")` exactly once at module load, so
// this is the one object every log line in the module goes through, and tests
// can assert on it. A mock that returns a new, unreachable function each call
// would let the bearer path's log line (or the touch-failure warning) be
// deleted without any test noticing.
const authInfo = vi.fn();
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
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => findByPk(...a) },
}));
vi.mock("jsonwebtoken", () => ({
  default: { verify: (...a: unknown[]) => jwtVerify(...a) },
}));
vi.mock("../utils/logger.js", () => ({ log: () => ({ info: authInfo, warn: authWarn }) }));

const { authenticate } = await import("./authenticate.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SESSION_TOUCH_THROTTLE_MINUTES, ROLE_HEADER } = await import("../config/security.js");

function call(opts: { cookie?: string; bearer?: string } = {}) {
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
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    ip: "::1",
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
});

describe("with a session cookie", () => {
  it("lets a live session through and says who it is", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    const c = call({ cookie: "buen-token" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.req.user).toMatchObject({ id: 7, id_sesion: "s1" });
  });

  it("reads the role from the database, not from anything the client sent", async () => {
    // A demoted person kept their old permissions for up to a week under the
    // old token. The role is re-read on every request for that reason.
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
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
      });
      const c = call({ cookie: "t" });
      await authenticate(c.req, c.res, c.next);
      expect(touchSession).toHaveBeenCalledWith("s1", NOW);
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
      });
      const c = call({ cookie: "el-token" });
      await authenticate(c.req, c.res, c.next);

      expect(slidingExpiry).toHaveBeenCalledWith(createdAt, NOW);
      expect(c.cookieCalls).toHaveLength(1);
      expect(c.cookieCalls[0].name).toBe(SESSION_COOKIE_NAME);
      expect(c.cookieCalls[0].value).toBe("el-token");
      expect(c.cookieCalls[0].options.expires).toBe(capped);
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
    });
    touchSession.mockRejectedValue(new Error("pool agotado"));
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    await vi.waitFor(() => expect(authWarn).toHaveBeenCalled());
  });

  it("never consults the old bearer path when a cookie is present", async () => {
    findLiveSession.mockResolvedValue(null);
    const c = call({ cookie: "malo", bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    // A cookie that fails is a failure. Falling back would let anyone who can
    // forge a JWT bypass revocation by also sending a broken cookie.
    expect(jwtVerify).not.toHaveBeenCalled();
    expect(c.status).toBe(401);
  });
});

describe("with the old bearer token, during the transition", () => {
  it("still lets it through, with the role the database has and not the one the token carries", async () => {
    // The JWT payload says id_rol: 1; the mocked database (see the top-level
    // beforeEach) says 2. Only the database's answer may end up on req.user —
    // reading the token's own id_rol instead would look like a harmless
    // optimisation (it saves the lookup the cookie path already pays for) and
    // would silently bring back the exact bug this rewrite exists to close:
    // a demoted or archived account keeps acting on a week-old JWT.
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.req.user).toEqual({ id: 7, id_rol: 2 });
  });

  it("leaves id_sesion empty, because there is no row for it", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.req.user?.id_sesion).toBeUndefined();
  });

  it("turns away someone whose account was archived since the token was issued", async () => {
    // The cookie path has its own test for this. The bearer path runs the
    // identical `!usuario` check through a different function
    // (`authenticateByLegacyToken`), reached through a `jwt.verify` callback
    // rather than a plain `await` — nothing proves it independently unless a
    // test exercises this path with a null lookup.
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    findByPk.mockResolvedValue(null);
    const c = call({ bearer: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });

  it("rejects an invalid one", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown) => void) => cb(new Error("bad")));
    const c = call({ bearer: "malo" });
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });

  it("logs every use of the old path, without the token itself ending up in the log", async () => {
    // This line is the count the retirement plan reads: the day it can show
    // zero uses in a week is the day the old path can be deleted. Losing it
    // silently would make that decision a guess again.
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "un.jwt.secreto" });
    await authenticate(c.req, c.res, c.next);

    expect(authInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id_usuario: 7 }),
      expect.any(String),
    );
    expect(JSON.stringify(authInfo.mock.calls[0])).not.toContain("un.jwt.secreto");
  });
});

describe("the current-role header", () => {
  // Task 2's whole point: the frontend used to notice a role change by
  // decoding `id_rol` out of a re-signed JWT (`x-new-token`, now dead — see
  // `app.ts`). This header replaces that mechanism, so it has to survive on
  // both credentials or the notice only works for half the transition, and
  // it has to come from the database or a demoted account keeps its old
  // buttons for as long as the token lives — precisely the defect the rest of
  // this file exists to close for `req.user.id_rol`.

  it("is set on the cookie path, from the database", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 4 } });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);

    expect(c.headers[ROLE_HEADER]).toBe("4");
  });

  it("is set on the old bearer path too, and from the database rather than the token", async () => {
    // The token's own claim says id_rol 1; the database (mocked here, distinct
    // on purpose) says 9. Only a header reading 9 proves this was not quietly
    // read off the credential — a value of 1 would mean the header brought
    // back exactly the bug `req.user.id_rol` is proven, a few tests up, not
    // to have.
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 9 } });
    const c = call({ bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    expect(c.headers[ROLE_HEADER]).toBe("9");
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

  it("answers 500 instead of hanging when the user lookup throws, bearer path", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    findByPk.mockRejectedValue(new Error("pool agotado"));
    const c = call({ bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(500);
    expect(c.next).not.toHaveBeenCalled();
  });
});
