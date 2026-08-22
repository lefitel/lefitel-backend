// What the old login does now that it also opens a session.
//
// `login.controller.test.ts` is the credential net — the uniform message, the
// levelled timings, the lockout — and it deliberately mocks the session away so
// that it keeps testing one thing. This file is the other half: that `POST
// /api/login` writes a session row and hands over the cookie *as well as* the
// JWT, and that failing to do so does not cost anybody their login.
//
// Why that pairing matters: it is what makes the migration gradual instead of a
// deployment where the frontend and the backend have to switch in the same
// instant. Everybody who logs in through the frontend as it is today is
// migrated without noticing; the day the new frontend ships they already have a
// session, and the bearer-path counter in `authenticate` is what says when the
// old token can go.
//
// The cookie helpers are real here on purpose. `res.cookie` is a spy, so the
// attributes a browser would actually receive — httpOnly, SameSite, Path — are
// asserted rather than assumed, which is the part that cannot be got right by
// looking at the call site.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findOne = vi.fn();
const update = vi.fn();
const increment = vi.fn().mockResolvedValue(undefined);
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...a: unknown[]) => findOne(...a),
    update: (...a: unknown[]) => update(...a),
    increment: (...a: unknown[]) => increment(...a),
  },
}));

// The store is mocked and the cookie helpers are not. That split is the point of
// the file: what is under test is the wiring between them, so the half that
// talks to Postgres is replaced and the half that talks to the browser is real.
const createSession = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
}));

vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));
vi.mock("jsonwebtoken", () => ({ default: { sign: () => "un.token.firmado" } }));
vi.mock("../permissions/store.js", () => ({ permissionsFor: async () => ({}) }));
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { loginUsuario } = await import("./login.controller.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");

const TOKEN = "un-token-opaco-de-sesion";
const CADUCA = new Date("2026-09-01T00:00:00.000Z");
const NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0) TestRunner";

/** An account whose password is right, stored at the current cost. */
function storedUser() {
  return {
    dataValues: {
      id: 7,
      id_rol: 2,
      user: "isaias",
      pass: "$2a$12$hash",
      name: "Isaias",
      lastname: "Salas",
      image: null,
      failed_attempts: 0,
      locked_until: null as Date | null,
    },
  };
}

function call(body: unknown) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    cookie: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return {
    req: {
      body,
      ip: "203.0.113.9",
      headers: { "user-agent": NAVEGADOR },
    } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as { usuario?: { token?: string }; message?: string } | undefined;
    },
    get cookieCall() {
      return res.cookie.mock.calls[0] as [string, string, Record<string, unknown>] | undefined;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(storedUser());
  createSession.mockResolvedValue({ token: TOKEN, expiresAt: CADUCA });
});

describe("the old login, once the credential is good", () => {
  it("opens a session row for the person who logged in", async () => {
    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(7, {
      // Both come off the request rather than being invented here: the session
      // list in the profile screen is only recognisable to its owner if these
      // are the browser and address that actually made the call.
      userAgent: NAVEGADOR,
      ip: "203.0.113.9",
    });
  });

  it("hands the token over as a cookie the page cannot read", async () => {
    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    const [name, value, options] = c.cookieCall ?? [];
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe(TOKEN);
    // httpOnly is the whole reason the cookie exists rather than a second token
    // in the body: a value JavaScript can read is a value any script on the page
    // can take. The rest is what stops it being sent from another site or over
    // plain HTTP, and what stops a subdomain shadowing it with a longer path.
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", expires: CADUCA });
  });

  it("still answers with the JWT, so the current frontend keeps working", async () => {
    // The transition rests on this. If the old body changed shape the whole
    // application would go down the moment the backend deployed, which is
    // precisely the coupling this plan exists to remove.
    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload?.usuario?.token).toBe("un.token.firmado");
  });

  it("lets the login through when the session cannot be opened", async () => {
    // Deliberate, and the opposite of what `POST /api/auth/login` does. Here the
    // JWT is the credential this endpoint promises and it works with or without
    // a session row, so a database hiccup must not turn a correct password into
    // a failed login over a feature nobody is using yet. It is logged, because
    // silence would let the migration quietly stop happening.
    createSession.mockRejectedValue(new Error("pool agotado"));

    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload?.usuario?.token).toBe("un.token.firmado");
    expect(warn).toHaveBeenCalled();
  });

  it("opens nothing when the credential is wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const c = call({ user: "isaias", pass: "equivocada" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    expect(c.cookieCall).toBeUndefined();
  });

  it("opens nothing when the request never had a username in it", async () => {
    const c = call({ pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
