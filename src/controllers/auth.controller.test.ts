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
const findLiveSession = vi.fn();
const listSessionsOf = vi.fn();
const revokeSessionOf = vi.fn();
const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  findLiveSession: (...a: unknown[]) => findLiveSession(...a),
  listSessionsOf: (...a: unknown[]) => listSessionsOf(...a),
  revokeSessionOf: (...a: unknown[]) => revokeSessionOf(...a),
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));

// The three factor tables, mocked at the model rather than mocking
// `factorInventory.js` wholesale: what the login does with the state is the
// wiring under test here, so the function that decides it stays real and only
// the tables under it are replaced — the same split that keeps
// `verifyCredentials` real in `auth.controller.test.ts`.
//
// They also cannot be left alone. Each of these modules calls
// `UsuarioModel.hasMany` as it is imported, and `UsuarioModel` is the stub
// above, so without these three the file fails to load before running an
// assertion.
const passkeyCount = vi.fn();
const totpCount = vi.fn();
vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: { count: (...a: unknown[]) => passkeyCount(...a) },
}));
vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: { count: (...a: unknown[]) => totpCount(...a) },
}));
// Never called — `estadoInicialDeSesion` goes through `tieneAlgunFactor`, which
// deliberately never asks about recovery codes. On the mock because
// `factorInventory.ts` imports the name, and a named import missing from a
// `vi.mock` factory fails the whole file at load rather than when it is reached.
vi.mock("../models/codigoRecuperacion.model.js", () => ({
  CodigoRecuperacionModel: { count: vi.fn() },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
// `login` calls this opportunistically after a successful login (see
// `tokenStore.ts`). Mocked wholesale like `sessionStore.js` above: without
// this, the real module would import the real `TokenUsoUnicoModel` and every
// "person really is in" test in this file would fire a genuine DELETE
// against whatever database this process is configured with.
const purgeExpiredTokens = vi.fn().mockResolvedValue(0);
vi.mock("../auth/tokenStore.js", () => ({
  purgeExpiredTokens: (...a: unknown[]) => purgeExpiredTokens(...a),
}));
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
const { CREDENCIALES_INCOMPLETAS, CREDENCIALES_INVALIDAS } = await import(
  "../config/security.js"
);
const bcryptjs = (await import("bcryptjs")).default;

const YO = 7;
const MI_ROL = 2;
// Hex *letters* in these on purpose. With all-numeric ids, the upper-case test
// below could not fail: `"1111-…".toUpperCase()` is the same string, so it went
// green with and without the normalisation it exists to pin. Found by breaking
// the code and watching nothing fall over.
const MI_SESION = "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa";
const OTRA_SESION = "bbbbbbbb-22de-4222-8222-bbbbbbbbbbbb";
const AJENA = "cccccccc-33ef-4333-8333-cccccccccccc";
const TOKEN = "un-token-opaco-de-sesion";
const CADUCA = new Date("2026-09-01T00:00:00.000Z");
// Deliberately not `CADUCA`: a test pinning this value has to fail if `me`
// starts computing its own date (`Date.now() + algo`) instead of reading the
// one `authenticate` already put on `req.user`, and a coincidence with
// another constant in this file would hide exactly that bug.
const SESION_EXPIRA = new Date("2027-03-14T00:00:00.000Z");
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
 *
 * The type comes from `Request["user"]` and is not written out again, which is
 * what makes an impossible caller impossible here too. Written out, it had
 * `id_sesion?` and `expires_at?` and went on accepting a caller with neither
 * long after `app.ts` made them required — and four tests in this file were
 * about exactly that caller, the one who arrived on the old bearer token with no
 * session row. Those four are gone with the credential; deriving the type is
 * what stops a fifth being written.
 */
function call(
  user: NonNullable<Request["user"]> | undefined,
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

/**
 * The only shape of caller there is: `authenticate` fills all four fields in or
 * answers 401.
 *
 * `expires_at` is on it now, and was not before. It could be left off while the
 * field was optional, so most of this file was exercising handlers with a
 * `req.user` the middleware cannot actually produce — harmless for the handlers
 * that ignore the field, and the reason `me` had a test for an answer no caller
 * could ever receive.
 */
const YO_CON_SESION = { id: YO, id_rol: MI_ROL, id_sesion: MI_SESION, expires_at: CADUCA };

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` forgets the calls, not the resolved values, so a test that
  // pins `compare` to false leaks that into every test after it. Pinned back
  // here rather than in each test: the ordering trap is not worth rediscovering.
  vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
  findOne.mockResolvedValue(storedUser());
  findByPk.mockResolvedValue(storedUser());
  createSession.mockResolvedValue({ token: TOKEN, expiresAt: CADUCA });
  findLiveSession.mockResolvedValue(null);
  listSessionsOf.mockResolvedValue([]);
  revokeSessionOf.mockResolvedValue(true);
  revokeAllSessionsOf.mockResolvedValue(0);
  permissionsFor.mockResolvedValue(PERMISOS);
  purgeExpiredTokens.mockResolvedValue(0);
  // Nothing registered, which is every account on the day this deploys.
  passkeyCount.mockResolvedValue(0);
  totpCount.mockResolvedValue(0);
  update.mockResolvedValue([1]);
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
    // The exact sentence, and deliberately not the one a bad credential gets:
    // this is about the request and gives nothing away about who has an account
    // here. Both messages live in `config/security.ts` now, so neither can be
    // reworded without the other in view.
    expect(c.message).toBe(CREDENCIALES_INCOMPLETAS);
    expect(c.message).not.toBe(CREDENCIALES_INVALIDAS);
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

  it("fails the login, with 503 and something to say, when the session cannot be opened", async () => {
    // The session *is* the credential, so answering 200 without one would hand
    // the browser a login that every other route refuses.
    //
    // 503 rather than the 500 `handler()` would have produced. This endpoint
    // answered 500 until the two doors were merged onto it: the retired `POST
    // /api/login` had a catch of its own around `issueSession` and this did
    // not, so the better answer to the one login failure a person can act on
    // lived on the door being retired. It came across with the merge. Pinned
    // here **and** in `login.session.test.ts` on purpose, because a rejection
    // is the easiest thing in the file to hand back to the wrapper by accident.
    createSession.mockRejectedValue(new Error("pool agotado"));
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(503);
    // Both sentences written out by hand rather than imported, so that
    // rewording either one has to argue with a test — the same reason the
    // header names are literals in `app.security.test.ts`. The second is the
    // one the wrapper would have produced, and it is the assertion that
    // catches a 503 carrying the wrong words.
    expect(c.message).toBe(
      "No se pudo iniciar la sesión en este momento. Inténtelo de nuevo en unos minutos.",
    );
    expect(c.message).not.toBe("Ocurrió un error al procesar la petición.");
    expect(c.raw.cookie).not.toHaveBeenCalled();
  });

  it("does not write a LOGIN line for a login that failed to open a session", async () => {
    // The line used to be written the moment the password checked out, from
    // inside `verifyCredentials`. So a request that then failed to open a
    // session was refused while the bitácora said that person had logged in —
    // and the bitácora is read precisely to find out what happened.
    const { logAction } = await import("../utils/logAction.js");
    createSession.mockRejectedValue(new Error("pool agotado"));
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(503);
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LOGIN" }));
  });

  it("writes the LOGIN line when the person really is in", async () => {
    // The other direction of the same move: it must still be written, and with
    // the address, which is what tells one machine grinding one account apart
    // from a person mistyping their own.
    const { logAction } = await import("../utils/logAction.js");
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LOGIN", entity_id: YO, ip_address: "203.0.113.9" }),
    );
  });

  it("sweeps token_uso_unico on a successful login, instead of on a schedule", async () => {
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(purgeExpiredTokens).toHaveBeenCalledOnce();
  });

  it("still answers 200 when the opportunistic purge itself fails", async () => {
    // Fire-and-forget: this is housekeeping for a table this request never
    // touched, so its failure must not turn a successful login into a 500.
    purgeExpiredTokens.mockRejectedValue(new Error("token_uso_unico no existe"));
    const c = call(undefined, { body: { user: "isaias", pass: "secreta" } });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
  });
});

describe("GET /api/auth/me", () => {
  it("reads the role from the database and not from the credential", async () => {
    // Under the old token this answered with the token's own payload, which is a
    // photograph taken the day the person logged in: somebody moved to another
    // role kept the old buttons for the rest of the week, because the interface
    // draws itself from this answer.
    //
    // `id_rol: 99` is the credential's claim and 1 is the database's, so only
    // reading the database passes. Spelt out rather than using `YO_CON_SESION`
    // for that reason alone.
    findByPk.mockResolvedValue(storedUser({ id_rol: 1 }));
    const c = call({ ...YO_CON_SESION, id_rol: 99 });
    await me(c.req, c.res);

    expect(c.status).toBe(200);
    expect((c.payload?.usuario as { id_rol: number }).id_rol).toBe(1);
    expect(permissionsFor).toHaveBeenCalledWith(1);
  });

  it("asks only for the fields it publishes", async () => {
    // Listed one by one rather than excluding `pass`. The next plan adds
    // `email`, `mfa_grace_until` and more to this table, and an exclusion list
    // publishes every one of them the day the migration runs.
    //
    // That plan arrived, and this is what deliberate looks like: `email` and
    // `email_verified_at` were added here on purpose, because the profile
    // screen draws both. What did *not* come with them — `failed_attempts`,
    // `locked_until`, and `pass` above all — is the whole reason this list is
    // written out by hand. An exclusion list would have handed over all three
    // without anybody deciding to.
    const c = call(YO_CON_SESION);
    await me(c.req, c.res);

    const [id, options] = findByPk.mock.calls[0] as [number, { attributes: string[] }];
    expect(id).toBe(YO);
    expect(options.attributes).toEqual([
      "id", "id_rol", "user", "name", "lastname", "image", "email", "email_verified_at",
    ]);
    // The point of the assertion above, stated so it cannot rot into a
    // rubber stamp: whatever else changes, these never appear.
    for (const jamas of ["pass", "failed_attempts", "locked_until"]) {
      expect(options.attributes).not.toContain(jamas);
    }
  });

  it("ends the session when the account is no longer there", async () => {
    findByPk.mockResolvedValue(null);
    const c = call(YO_CON_SESION);
    await me(c.req, c.res);

    expect(c.status).toBe(401);
  });

  it("answers with this session's own expiry, not one computed in the handler", async () => {
    // `SESION_EXPIRA` has nothing to do with "now" — it is here so that a
    // handler which starts inventing its own date (`Date.now() + 7 days`,
    // the cookie's own sliding expiry, anything computed) cannot happen to
    // match it. Only reading `req.user.expires_at` verbatim passes.
    const c = call({ id: YO, id_rol: MI_ROL, id_sesion: MI_SESION, expires_at: SESION_EXPIRA });
    await me(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload?.expires_at).toEqual(SESION_EXPIRA);
  });

  it("always answers with a date, never with null", async () => {
    /**
     * What is left of the test this replaces, and why it could not simply stay.
     *
     * It was called "says it does not know, rather than nothing at all, on the
     * old bearer token", and it pinned `expires_at: null` for a caller with no
     * session row: to `JSON.parse` an absent key reads exactly like a key
     * nobody remembered to send, so `null` was the one answer a client could
     * not mistake for a bug. The reasoning was sound and its subject is gone —
     * `authenticate` lets nothing through without a live row, so there is no
     * caller left to receive the `null`, and the `?? null` that produced it
     * went with the branch. Keeping the test would have meant building a caller
     * by cast that the middleware cannot produce, and asserting what the
     * handler does with impossible input is how a test starts defending a shape
     * instead of a behaviour.
     *
     * What is worth keeping is the half that is still checkable: whatever this
     * endpoint answers, the key is present and it is a date. That is what a
     * client schedules its countdown off, and re-introducing a nullable field
     * here would be a silent change to a contract two repositories share.
     */
    const c = call(YO_CON_SESION);
    await me(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload).toHaveProperty("expires_at");
    expect(c.payload?.expires_at).toEqual(CADUCA);
    expect(c.payload?.expires_at).not.toBeNull();
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
    // With the caller's own id, not merely with the session id. There is one way
    // to revoke a session in this codebase now and the owner is not optional in
    // it — the shorter `revokeSession(id)` was deleted rather than left lying
    // around for the next person to reach for.
    expect(revokeSessionOf).toHaveBeenCalledWith(YO, MI_SESION);
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

  it("says the plain thing, and there is no longer a second thing to say", async () => {
    // This endpoint used to answer one of two sentences. A caller who arrived on
    // the old bearer token had no row of their own to revoke and no way to
    // revoke their credential at all, so they were told plainly that this
    // browser was the exception — "se cerraron sus sesiones, pero este navegador
    // seguirá dentro" — which was the honest description of the hole. The caller
    // is gone and so is the sentence, and the test that pinned it went with
    // them. Asserted by equality rather than by a regular expression, because
    // what is being pinned is that there is exactly one answer.
    const c = call(YO_CON_SESION);
    await logoutAll(c.req, c.res);

    expect(c.message).toBe("Se cerraron todas sus sesiones.");
    expect(c.message).not.toMatch(/seguirá dentro/i);
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
    const ajena = call(YO_CON_SESION, { params: { id: AJENA } });
    await endSession(ajena.req, ajena.res);

    expect(ajena.status).toBe(404);
    expect(revokeSessionOf).toHaveBeenCalledWith(YO, AJENA);

    // And indistinguishable from an id that never named anything: same status,
    // same words. A `toBe(404)` followed by `not.toBe(403)` would have been two
    // assertions saying one thing; this is the second thing.
    const inventada = call(YO_CON_SESION, { params: { id: "no-es-un-uuid" } });
    await endSession(inventada.req, inventada.res);

    expect(inventada.status).toBe(ajena.status);
    expect(inventada.message).toBe(ajena.message);
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

  it("takes the cookie back even when the id arrives in upper case", async () => {
    // Postgres normalises the `uuid` type, so the row was always revoked; the
    // comparison that decides whether to clear the cookie is JavaScript's, and
    // that one is byte-for-byte. Before the id was lower-cased, closing your own
    // session in upper case answered 200, revoked the row, wrote
    // `era_la_actual: false` and left the cookie in place — and the browser went
    // on sending a revoked token, collecting 401s with nothing to explain why.
    const c = call(YO_CON_SESION, { params: { id: MI_SESION.toUpperCase() } });
    await endSession(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeSessionOf).toHaveBeenCalledWith(YO, MI_SESION);
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
      ["logout", logout, () => revokeSessionOf.mockRejectedValue(new Error("caída"))],
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
