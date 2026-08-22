// Who gets in.
//
// Two credentials during the transition: the cookie, and the old bearer token.
// The order matters and the fallback matters, but what matters most is what
// happens when a session has been revoked — that is the entire reason this
// middleware is being rewritten.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const findLiveSession = vi.fn();
const touchSession = vi.fn();
const findByPk = vi.fn();
const jwtVerify = vi.fn();

vi.mock("../auth/sessionStore.js", () => ({
  findLiveSession: (...a: unknown[]) => findLiveSession(...a),
  touchSession: (...a: unknown[]) => touchSession(...a),
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => findByPk(...a) },
}));
vi.mock("jsonwebtoken", () => ({
  default: { verify: (...a: unknown[]) => jwtVerify(...a) },
}));
vi.mock("../utils/logger.js", () => ({ log: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const { authenticate } = await import("./authenticate.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");

function call(opts: { cookie?: string; bearer?: string } = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    sendStatus(c: number) { this.statusCode = c; return this; },
  };
  const req = {
    cookies: opts.cookie ? { [SESSION_COOKIE_NAME]: opts.cookie } : {},
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    ip: "::1",
  } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res: res as unknown as Response, next, get status() { return res.statusCode; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 2 } });
  touchSession.mockResolvedValue(undefined);
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
  });

  it("does not write last_used_at on every single request", async () => {
    // One report export makes around two thousand sequential requests. Writing
    // on each one is two thousand UPDATEs on one row.
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(touchSession).not.toHaveBeenCalled();
  });

  it("does write it once the throttle has passed", async () => {
    findLiveSession.mockResolvedValue({
      id: "s1", id_usuario: 7,
      expires_at: new Date(Date.now() + 1e6),
      last_used_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(touchSession).toHaveBeenCalledWith("s1", expect.any(Date));
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
  it("still lets it through", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.req.user).toMatchObject({ id: 7 });
  });

  it("leaves id_sesion empty, because there is no row for it", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.req.user?.id_sesion).toBeUndefined();
  });

  it("rejects an invalid one", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown) => void) => cb(new Error("bad")));
    const c = call({ bearer: "malo" });
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
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
