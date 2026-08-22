// The six session endpoints.
//
// Two things in this file are worth more than the rest, and both are about what
// an endpoint refuses.
//
// The first is `DELETE /sessions/:id`. The id comes from the URL, so it is the
// caller's to write, and this repository has already shipped a `:id` route that
// trusted one — `PUT /usuario/:id` handed the body straight to `set()`, so any
// account could send `{ id_rol: 1 }` at its own id and come back an
// administrator. The assertion here is not "somebody else's session gets a
// 404": that only proves the controller believes the store. It is that the
// caller's own id is what the store is asked with, which is the thing that
// cannot be true by accident.
//
// The second is `POST /login`. `verifyCredentials` is real here — only the
// models under it are mocked — so a locked account really does travel the whole
// path. That is what pins the reuse: if somebody ever copied the credential
// check into this controller and left the lockout out of the copy, the test
// about the locked account would go green on the copy and this file would say
// nothing. With the real function in place, it cannot.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findOne = vi.fn();
const findByPk = vi.fn();
const update = vi.fn();
const increment = vi.fn().mockResolvedValue(undefined);
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...a: unknown[]) => findOne(...a),
    findByPk: (...a: unknown[]) => findByPk(...a),
    update: (...a: unknown[]) => update(...a),
    increment: (...a: unknown[]) => increment(...a),
  },
}));

const createSession = vi.fn();
const listSessionsOf = vi.fn();
const revokeSession = vi.fn();
const revokeSessionOf = vi.fn();
const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  listSessionsOf: (...a: unknown[]) => listSessionsOf(...a),
  revokeSession: (...a: unknown[]) => revokeSession(...a),
  revokeSessionOf: (...a: unknown[]) => revokeSessionOf(...a),
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));

vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));
// The matrix is asked for, not computed: which answer the database gives is
// `permissions/store.test.ts`'s business. What matters here is that the role
// used to ask comes from the database row and not from the credential.
const permissionsFor = vi.fn();
vi.mock("../permissions/store.js", () => ({
  permissionsFor: (...a: unknown[]) => permissionsFor(...a),
}));
vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { login, me, logout, logoutAll, sessions, endSession } = await import("./auth.controller.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { CREDENCIALES_INVALIDAS } = await import("../config/security.js");
const bcryptjs = (await import("bcryptjs")).default;

const YO = 7;
const MI_ROL = 2;
const MI_SESION = "11111111-1111-4111-8111-111111111111";
const OTRA_SESION = "22222222-2222-4222-8222-222222222222";
const AJENA = "33333333-3333-4333-8333-333333333333";
const TOKEN = "un-token-opaco-de-sesion";
const CADUCA = new Date("2026-09-01T00:00:00.000Z");
const PERMISOS = { seguridad: { ver: true } };

function storedUser(overrides: Record<string, unknown> = {}) {
  return {
    dataValues: {
      id: YO,
      id_rol: MI_ROL,
      user: "isaias",
      pass: "$2a$12$hash",
      name: "Isaias",
      lastname: "Salas",
      image: null,
      failed_attempts: 0,
      locked_until: null as Date | null,
      ...overrides,
    },
  };
}

/**
 * A request, and everything the handlers are allowed to reach for.
 *
 * `user` is what `authenticate` would have put there. Passing `undefined` is not
 * a hypothetical: every handler is asserted below to refuse in that case rather
 * than carry on, because a guard that only works because another guard ran is
 * not a guard — the same lesson `usuario.controller.test.ts` was written for.
 */
function call(
  user: { id: number; id_rol: number; id_sesion?: string } | undefined,
  { params = {}, body = {} }: { params?: Record<string, string>; body?: unknown } = {},
) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return {
    req: {
      user,
      params,
      body,
      ip: "203.0.113.9",
      originalUrl: "/api/auth/x",
      headers: { "user-agent": "TestRunner" },
    } as unknown as Request,
    res: res as unknown as Response,
    raw: res,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as Record<string, unknown> | undefined;
    },
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
  };
}

const YO_CON_SESION = { id: YO, id_rol: MI_ROL, id_sesion: MI_SESION };
/** A caller who arrived with the old bearer token: no session row behind them. */
const YO_CON_TOKEN_VIEJO = { id: YO, id_rol: MI_ROL };

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` forgets the calls, not the resolved values, so a test that
  // pins `compare` to false leaks that into every test after it. Pinned back
  // here rather than in each test: the ordering trap is not worth rediscovering.
  vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
  findOne.mockResolvedValue(storedUser());
  findByPk.mockResolvedValue(storedUser());
  createSession.mockResolvedValue({ token: TOKEN, expiresAt: CADUCA });
  listSessionsOf.mockResolvedValue([]);
  revokeSession.mockResolvedValue(undefined);
  revokeSessionOf.mockResolvedValue(true);
  revokeAllSessionsOf.mockResolvedValue(0);
  permissionsFor.mockResolvedValue(PERMISOS);
});

describe("POST /api/auth/login", () => {
  it("never puts the token in the body", async () => {
    // The whole point of the endpoint. A token in the body is a token in
    // JavaScript's reach, which is a token any script on the page can read —
    // and one that nothing can revoke, because the browser keeps its own copy.
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(JSON.stringify(c.payload)).not.toContain(TOKEN);
    expect(c.payload?.usuario).not.toHaveProperty("token");
    expect(c.payload).not.toHaveProperty("token");
  });

  it("hands the session over as an httpOnly cookie instead", async () => {
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    const [name, value, options] = c.raw.cookie.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe(TOKEN);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("sends the user and the permissions, so the first screen is already right", async () => {
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.payload?.usuario).toMatchObject({ id: YO, id_rol: MI_ROL, user: "isaias" });
    expect(c.payload?.permisos).toEqual(PERMISOS);
    // Never the hash, whatever else travels.
    expect(JSON.stringify(c.payload)).not.toContain("$2a$12$hash");
  });

  it("refuses a body with nothing in it, without looking anything up", async () => {
    const c = call(undefined, { body: {} });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("answers a locked account exactly as it answers a wrong password", async () => {
    // This is the reuse test. `verifyCredentials` is the real function here, so
    // the lockout, the uniform message and the filler hash that levels the two
    // timings all apply to this endpoint because they apply to that function —
    // not because they were copied into this controller and kept in step by
    // hand. Copy the logic and leave the lockout out of the copy, and this test
    // is what notices.
    const bcryptjs = (await import("bcryptjs")).default;

    findOne.mockResolvedValue(storedUser({ locked_until: new Date(Date.now() + 60_000) }));
    const bloqueada = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(bloqueada.req, bloqueada.res);

    vi.clearAllMocks();
    permissionsFor.mockResolvedValue(PERMISOS);
    findOne.mockResolvedValue(storedUser());
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const mala = call(undefined, { body: { user: "isaias", pass: "equivocada" } });
    await login(mala.req, mala.res);

    expect(bloqueada.status).toBe(400);
    expect(bloqueada.message).toBe(CREDENCIALES_INVALIDAS);
    expect(mala.status).toBe(bloqueada.status);
    expect(mala.message).toBe(bloqueada.message);
  });

  it("opens no session when the credential is refused", async () => {
    findOne.mockResolvedValue(null);
    const c = call(undefined, { body: { user: "nadie", pass: "x" } });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    expect(c.raw.cookie).not.toHaveBeenCalled();
  });

  it("fails the login when the session cannot be opened", async () => {
    // The opposite of `POST /api/login`, and deliberately so: here the session
    // *is* the credential, so answering 200 without one would hand the browser
    // a login that every other route refuses.
    createSession.mockRejectedValue(new Error("pool agotado"));
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(500);
    expect(c.raw.cookie).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/me", () => {
  it("reads the role from the database and not from the credential", async () => {
    // Under the old token this answered with the token's own payload, which is a
    // photograph taken the day the person logged in: somebody moved to another
    // role kept the old buttons for the rest of the week, because the interface
    // draws itself from this answer.
    findByPk.mockResolvedValue(storedUser({ id_rol: 1 }));
    const c = call({ id: YO, id_rol: 99, id_sesion: MI_SESION });
    await me(c.req, c.res);

    expect(c.status).toBe(200);
    expect((c.payload?.usuario as { id_rol: number }).id_rol).toBe(1);
    expect(permissionsFor).toHaveBeenCalledWith(1);
  });

  it("asks only for the fields it publishes", async () => {
    // Listed one by one rather than excluding `pass`. The next plan adds
    // `email`, `mfa_grace_until` and more to this table, and an exclusion list
    // publishes every one of them the day the migration runs.
    const c = call(YO_CON_SESION);
    await me(c.req, c.res);

    const [id, options] = findByPk.mock.calls[0] as [number, { attributes: string[] }];
    expect(id).toBe(YO);
    expect(options.attributes).toEqual(["id", "id_rol", "user", "name", "lastname", "image"]);
  });

  it("ends the session when the account is no longer there", async () => {
    findByPk.mockResolvedValue(null);
    const c = call(YO_CON_SESION);
    await me(c.req, c.res);

    expect(c.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes this session and no other", async () => {
    // Somebody logging out of the office computer has not asked to be logged
    // out of their phone. A logout that closed everything would make the button
    // in the corner do something nobody expects.
    const c = call(YO_CON_SESION);
    await logout(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(MI_SESION);
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });

  it("takes the cookie back as well as revoking the row", async () => {
    // Either half alone is a half-logout: the row without the cookie leaves the
    // browser sending a dead credential, and the cookie without the row leaves a
    // working session for whoever kept a copy of the token.
    const c = call(YO_CON_SESION);
    await logout(c.req, c.res);

    const [name, options] = c.raw.clearCookie.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe(SESSION_COOKIE_NAME);
    // Same attributes as when it was set: a browser only drops a cookie whose
    // name and attributes match.
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("says to log in again when the request arrived on the old token", async () => {
    // No session row to revoke, and saying so beats pretending it worked: the
    // JWT stays valid either way, and only logging in again produces something
    // revocable. A 400 and not a 500 — nothing here is broken.
    const c = call(YO_CON_TOKEN_VIEJO);
    await logout(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/vuelva a iniciar sesión/i);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/logout-all", () => {
  it("revokes every session the caller has", async () => {
    // The button for "I lost my laptop", and the one thing the JWT could never
    // do. No `except`: this one really is all of them.
    revokeAllSessionsOf.mockResolvedValue(3);
    const c = call(YO_CON_SESION);
    await logoutAll(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(YO);
    expect(c.payload?.cerradas).toBe(3);
    expect(c.raw.clearCookie).toHaveBeenCalled();
  });

  it("works for a caller who arrived on the old token", async () => {
    // Revocation is by user id, so there is nothing this needs a session row
    // for. The bearer token itself stays valid until it expires, which is the
    // hole this plan documents rather than the one it can close today.
    const c = call(YO_CON_TOKEN_VIEJO);
    await logoutAll(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(YO);
  });

  it("never revokes anybody else's, whatever the request says", async () => {
    const c = call(YO_CON_SESION, { body: { id_usuario: 1 }, params: { id: "1" } });
    await logoutAll(c.req, c.res);

    expect(revokeAllSessionsOf).toHaveBeenCalledWith(YO);
  });
});

describe("GET /api/auth/sessions", () => {
  it("asks for the caller's own sessions and nobody else's", async () => {
    const c = call(YO_CON_SESION, { params: { id: "1" }, body: { id_usuario: 1 } });
    await sessions(c.req, c.res);

    expect(listSessionsOf).toHaveBeenCalledWith(YO);
  });

  it("marks the session doing the asking", async () => {
    // What the screen needs to say "this device", and to warn before closing
    // the session the request is coming from.
    listSessionsOf.mockResolvedValue([
      { id: MI_SESION, user_agent: "Chrome", ip_address: "1.2.3.4", created_at: CADUCA, last_used_at: CADUCA, expires_at: CADUCA, revoked_at: null, id_usuario: YO },
      { id: OTRA_SESION, user_agent: "Firefox", ip_address: "5.6.7.8", created_at: CADUCA, last_used_at: CADUCA, expires_at: CADUCA, revoked_at: null, id_usuario: YO },
    ]);
    const c = call(YO_CON_SESION);
    await sessions(c.req, c.res);

    const lista = c.payload?.sesiones as { id: string; actual: boolean }[];
    expect(lista.find((s) => s.id === MI_SESION)?.actual).toBe(true);
    expect(lista.find((s) => s.id === OTRA_SESION)?.actual).toBe(false);
  });

  it("marks nothing as current when the request arrived on the old token", async () => {
    // Honest and needs no error: the list of sessions is still exactly right,
    // there simply is no row for this request to be one of.
    listSessionsOf.mockResolvedValue([
      { id: MI_SESION, user_agent: "Chrome", ip_address: "1.2.3.4", created_at: CADUCA, last_used_at: CADUCA, expires_at: CADUCA, revoked_at: null, id_usuario: YO },
    ]);
    const c = call(YO_CON_TOKEN_VIEJO);
    await sessions(c.req, c.res);

    expect(c.status).toBe(200);
    expect((c.payload?.sesiones as { actual: boolean }[])[0].actual).toBe(false);
  });

  it("publishes the seven fields it means to and not whatever the table grows", async () => {
    // `listSessionsOf` already leaves out `token_hash`, but this table is going
    // to grow: the next plan adds `webauthn_challenge`, `mfa_source` and
    // `estado` to it. A spread would publish all three the day that migration
    // runs, with nothing failing.
    listSessionsOf.mockResolvedValue([
      {
        id: MI_SESION,
        id_usuario: YO,
        token_hash: "no-deberia-salir-de-la-base",
        webauthn_challenge: "un-reto-en-curso",
        user_agent: "Chrome",
        ip_address: "1.2.3.4",
        created_at: CADUCA,
        last_used_at: CADUCA,
        expires_at: CADUCA,
        revoked_at: null,
      },
    ]);
    const c = call(YO_CON_SESION);
    await sessions(c.req, c.res);

    const fila = (c.payload?.sesiones as Record<string, unknown>[])[0];
    expect(Object.keys(fila).sort()).toEqual([
      "actual", "created_at", "expires_at", "id", "ip_address", "last_used_at", "user_agent",
    ]);
    expect(JSON.stringify(c.payload)).not.toContain("no-deberia-salir-de-la-base");
    expect(JSON.stringify(c.payload)).not.toContain("un-reto-en-curso");
  });
});

describe("DELETE /api/auth/sessions/:id", () => {
  it("scopes the revocation by the caller, not only by the id in the URL", async () => {
    // The assertion this whole file exists for. A `DELETE /:id` that passes the
    // URL's id on its own is how the last IDOR in this repository was shaped.
    const c = call(YO_CON_SESION, { params: { id: OTRA_SESION } });
    await endSession(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeSessionOf).toHaveBeenCalledWith(YO, OTRA_SESION);
  });

  it("answers 404, and never 403, for a session that is not the caller's", async () => {
    // 403 would confirm the row exists and belongs to somebody, which turns the
    // endpoint into a way of finding out who is logged in right now.
    revokeSessionOf.mockResolvedValue(false);
    const c = call(YO_CON_SESION, { params: { id: AJENA } });
    await endSession(c.req, c.res);

    expect(c.status).toBe(404);
    expect(c.status).not.toBe(403);
    expect(revokeSessionOf).toHaveBeenCalledWith(YO, AJENA);
  });

  it("does not reach the database with an id that is not a uuid", async () => {
    // `sesiones.id` is a UUID column, and Postgres does not answer "no rows" to
    // `WHERE id = 'pepito'` — it raises 22P02. Without the shape check, any
    // authenticated caller could turn this route into a 500 with a stack trace
    // in the log, on demand.
    for (const id of ["pepito", "1", "'; DROP TABLE sesiones; --", MI_SESION.slice(0, -1)]) {
      vi.clearAllMocks();
      revokeSessionOf.mockResolvedValue(true);
      const c = call(YO_CON_SESION, { params: { id } });
      await endSession(c.req, c.res);

      expect(c.status, id).toBe(404);
      expect(revokeSessionOf, id).not.toHaveBeenCalled();
    }
  });

  it("takes the cookie back when the session closed is the one asking", async () => {
    // Allowed — it is the same act as logging out — but then the cookie has to
    // go too, or the browser keeps sending a revoked token and collecting 401s
    // with nothing saying why.
    const c = call(YO_CON_SESION, { params: { id: MI_SESION } });
    await endSession(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.raw.clearCookie).toHaveBeenCalled();
  });

  it("leaves the cookie alone when closing another device", async () => {
    const c = call(YO_CON_SESION, { params: { id: OTRA_SESION } });
    await endSession(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.raw.clearCookie).not.toHaveBeenCalled();
  });
});

/**
 * Every handler refuses when there is no caller, rather than carrying on.
 *
 * `authenticate` runs in front of all five of these, so this is not reachable
 * today — and that is exactly the argument that was used for
 * `if (loggedUser && …)` in `usuario.controller.ts`, which skipped the check
 * instead of refusing. A guard that works only because another guard ran is not
 * defence in depth.
 */
describe("with no caller at all", () => {
  const handlers = [
    ["me", me],
    ["logout", logout],
    ["logoutAll", logoutAll],
    ["sessions", sessions],
    ["endSession", endSession],
  ] as const;

  it("answers 401 and touches nothing", async () => {
    for (const [what, handler] of handlers) {
      vi.clearAllMocks();
      const c = call(undefined, { params: { id: MI_SESION } });
      await handler(c.req, c.res);

      expect(c.status, what).toBe(401);
      expect(revokeSession, what).not.toHaveBeenCalled();
      expect(revokeSessionOf, what).not.toHaveBeenCalled();
      expect(revokeAllSessionsOf, what).not.toHaveBeenCalled();
      expect(listSessionsOf, what).not.toHaveBeenCalled();
      expect(findByPk, what).not.toHaveBeenCalled();
    }
  });
});

/**
 * An unexpected failure is a 500, not a request that never answers.
 *
 * Express 4 does not catch a rejected promise from an `async` handler: it never
 * reaches the terminal handler in `app.ts`, the request just hangs until the
 * client gives up. Every handler here is wrapped for that reason, and this is
 * what says the wrapper is really around all of them.
 */
describe("when the database falls over", () => {
  it("answers 500 rather than leaving the request hanging", async () => {
    const cases = [
      ["me", me, () => findByPk.mockRejectedValue(new Error("caída"))],
      ["logout", logout, () => revokeSession.mockRejectedValue(new Error("caída"))],
      ["logoutAll", logoutAll, () => revokeAllSessionsOf.mockRejectedValue(new Error("caída"))],
      ["sessions", sessions, () => listSessionsOf.mockRejectedValue(new Error("caída"))],
      ["endSession", endSession, () => revokeSessionOf.mockRejectedValue(new Error("caída"))],
    ] as const;

    for (const [what, handler, breakIt] of cases) {
      vi.clearAllMocks();
      breakIt();
      const c = call(YO_CON_SESION, { params: { id: OTRA_SESION } });
      await handler(c.req, c.res);

      expect(c.status, what).toBe(500);
      expect(c.message, what).not.toContain("caída");
    }
  });
});
