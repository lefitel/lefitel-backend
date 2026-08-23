// What the login does with the session: rotate, open, hand over the cookie —
// and hand over nothing else.
//
// The three files around this one divide the endpoint up, and the division is
// deliberate. `login.controller.test.ts` is the credential net — the uniform
// message, the levelled timings, the lockout — with the session mocked away so
// it keeps testing one thing. `auth.controller.test.ts` is the six session
// endpoints and what each one refuses. This file is the wiring between the
// login and the session: `issueSession` is **real** here, so the rotation of a
// session the browser was already holding is asserted through the code that
// actually does it, which is coverage no other file has.
//
// It used to be about `POST /api/login` specifically, which had its own handler
// signing a JWT into the body beside the cookie. That handler is retired; the
// old address is mounted on the same `login` this file now imports, so what is
// under test is the one login the API has. The test that pinned the JWT into
// the body has been turned round: it pins that nothing resembling a credential
// is in there at all.
//
// The cookie helpers are real here on purpose. `res.cookie` is a spy, so the
// attributes a browser would actually receive — httpOnly, SameSite, Path,
// expiry — are asserted rather than assumed, which is the part that cannot be
// got right by looking at the call site.

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
const findLiveSession = vi.fn();
const revokeSessionOf = vi.fn();
// `listSessionsOf` and `revokeAllSessionsOf` are never called from here — they
// belong to the other five endpoints in `auth.controller.ts`. They are on the
// mock because that module imports them by name, and a named import missing
// from a `vi.mock` factory fails the whole file at load rather than when it is
// reached.
vi.mock("../auth/sessionStore.js", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  findLiveSession: (...a: unknown[]) => findLiveSession(...a),
  revokeSessionOf: (...a: unknown[]) => revokeSessionOf(...a),
  listSessionsOf: vi.fn(),
  revokeAllSessionsOf: vi.fn(),
}));

vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));
// `jsonwebtoken` is deliberately **not** mocked, and that is a tripwire rather
// than an omission. Nothing on this path signs anything any more, so there is
// nothing to stub; if somebody puts a `jwt.sign` back into the handler, it runs
// the real library against whatever `JWT_SECRET` this environment has, and the
// body assertion below is what fails.
vi.mock("../permissions/store.js", () => ({ permissionsFor: async () => ({}) }));
// Reachable mocks, not fresh `vi.fn()`s handed out per `log(...)` call.
// `auth.controller.ts` calls `log("auth")` once at module load, so these are
// the objects every line in the module goes through and a test can assert on
// them — which is what lets the session-failure test below prove the failure
// was written down and not swallowed.
const warn = vi.fn();
const error = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn, error, info: vi.fn(), debug: vi.fn() }),
}));

// `login`, not the retired `loginUsuario`: `POST /api/login` and `POST
// /api/auth/login` are both mounted on this one function now — see
// `login.routes.ts`.
const { login } = await import("./auth.controller.js");
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

function call(body: unknown, cookies?: Record<string, unknown>) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    cookie: vi.fn(),
    // `handler()` in `auth.controller.ts` checks this before writing its 500,
    // so the stub has to have it rather than leave it undefined by luck.
    headersSent: false,
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
      cookies,
      ip: "203.0.113.9",
      originalUrl: "/api/login/",
      headers: { "user-agent": NAVEGADOR },
    } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as
        | { usuario?: Record<string, unknown>; permisos?: unknown; message?: string }
        | undefined;
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
  findLiveSession.mockResolvedValue(null);
  revokeSessionOf.mockResolvedValue(true);
});

describe("the login, once the credential is good", () => {
  it("opens a session row for the person who logged in", async () => {
    const c = call({ user: "isaias", pass: "secreta" });
    await login(c.req, c.res);

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
    await login(c.req, c.res);

    const [name, value, options] = c.cookieCall ?? [];
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe(TOKEN);
    // httpOnly is the whole reason the cookie exists rather than a second token
    // in the body: a value JavaScript can read is a value any script on the page
    // can take. The rest is what stops it being sent from another site or over
    // plain HTTP, and what stops a subdomain shadowing it with a longer path.
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", expires: CADUCA });
  });

  it("puts no credential of any kind in the body", async () => {
    // The point of the whole plan, and the assertion that was the other way
    // round until this task: this test used to read `usuario.token` and pin a
    // signed JWT into the body, because the frontend of the day was written
    // against it.
    //
    // What made a body credential worth removing is not that it was
    // redundant. It was that nothing could revoke it. A JWT has no row behind
    // it, so "cerrar todas mis sesiones" and a password change both left it
    // working until it expired a week later — and it lived where any script on
    // the page could read it. The cookie is httpOnly and has a row that a
    // DELETE can end.
    //
    // Asserted three ways on purpose, because "the field is gone" is the
    // assertion this project has watched pass against broken code: a check
    // that `usuario.token` is absent says nothing about a token arriving as
    // `jwt`, as `access_token`, or one level up beside `permisos`. So: the
    // exact old field, the whole serialised body against every spelling, and
    // an exhaustive list of the keys the body is allowed to have. The third is
    // the one that fails when somebody adds a credential under a name nobody
    // thought to forbid.
    const c = call({ user: "isaias", pass: "secreta" });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload?.usuario).not.toHaveProperty("token");
    const serialised = JSON.stringify(c.payload);
    for (const palabra of ["token", "jwt", "bearer", "credential", "secret"]) {
      expect(serialised.toLowerCase(), palabra).not.toContain(palabra);
    }
    expect(Object.keys(c.payload ?? {}).sort()).toEqual(["message", "permisos", "usuario"]);
    // And the fields the first screen is drawn from did survive: an endpoint
    // that answered `{}` would pass every line above.
    expect(c.payload?.usuario).toMatchObject({ id: 7, id_rol: 2, user: "isaias" });
  });

  it("refuses the login, with something to say, when the session cannot be opened", async () => {
    // A 200 with no cookie is a 200 with no credential: the person is told
    // "Bienvenido", navigated into the ERP, 401'd on the first request for
    // data and put back on the login form with nothing on screen to explain
    // it, identically on every attempt. So: no 200, no cookie, and a sentence
    // the login form can show.
    //
    // **503 and not the 500 the wrapper would give.** This is the assertion
    // that keeps the merge from being a regression. `POST /api/login` had this
    // status and `POST /api/auth/login` did not — its `handler()` turned the
    // rejection into a 500 and `ERROR_INESPERADO`, which tells the person
    // "something is wrong with the software" when the truth is "a dependency
    // is down, come back shortly". Now both addresses are this one function,
    // and the catch around `issueSession` is the only reason the better answer
    // survived. Delete it and this line fails.
    //
    // The message is written out by hand rather than imported from the
    // controller, because an expectation built from the source it is checking
    // moves with the change — the same reason the two shared header names are
    // literals in `app.security.test.ts`. The cost is one edit if the wording
    // changes, which is the point: the wording is what a person reads.
    createSession.mockRejectedValue(new Error("pool agotado"));

    const c = call({ user: "isaias", pass: "secreta" });
    await login(c.req, c.res);

    expect(c.status).toBe(503);
    expect(c.payload?.message).toBe(
      "No se pudo iniciar la sesión en este momento. Inténtelo de nuevo en unos minutos.",
    );
    // No half-login: nothing that could be mistaken for a credential, and no
    // cookie either. `issueSession` sets the cookie only after `createSession`
    // resolves, so this also pins the ordering — a cookie set from a token that
    // was never stored is a 401 on the very next request.
    expect(c.payload?.usuario).toBeUndefined();
    expect(c.cookieCall).toBeUndefined();
    // Written down at error level, not warn: this is an outage, and the log is
    // the only place it is visible to anyone who could fix it.
    expect(error).toHaveBeenCalled();
  });

  it("closes the session this browser was already holding", async () => {
    // The frontend does call `logout` now, but only when somebody presses the
    // button: closing the tab revokes nothing, and a logout the network lost is
    // announced rather than retried — `SesionProvider.tsx` puts the failure on
    // screen, which is not the same as closing the row. So an abandoned row per
    // login is still the normal case rather than the exception. Without
    // rotating here, twenty people entering one to three times a day against
    // seven-day sessions leaves seven to twenty live rows per account, every one
    // of them with the same user_agent and the same IP. `GET /auth/sessions`,
    // the screen
    // where somebody decides what to close, would be a column of identical
    // entries, none of which is a browser anybody is using — and every
    // abandoned token stays a working credential for a week.
    findLiveSession.mockResolvedValue({ id: "la-anterior", id_usuario: 7 });

    const c = call({ user: "isaias", pass: "secreta" }, { osefi_session: "token-anterior" });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(findLiveSession).toHaveBeenCalledWith("token-anterior");
    expect(revokeSessionOf).toHaveBeenCalledWith(7, "la-anterior");
    // And the new one still gets opened: rotation replaces, it does not skip.
    expect(createSession).toHaveBeenCalledWith(7, expect.anything());
  });

  it("revokes nothing when the cookie it was sent is already dead", async () => {
    // An expired or revoked token has no row to close, and `findLiveSession`
    // saying so must not turn into a revocation of something else.
    findLiveSession.mockResolvedValue(null);

    const c = call({ user: "isaias", pass: "secreta" }, { osefi_session: "token-caducado" });
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeSessionOf).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalled();
  });

  it("does not go looking for a previous session when there is no cookie", async () => {
    const c = call({ user: "isaias", pass: "secreta" });
    await login(c.req, c.res);

    expect(findLiveSession).not.toHaveBeenCalled();
    expect(revokeSessionOf).not.toHaveBeenCalled();
  });

  it("keeps a database error's own words out of the response to a caller who has not logged in", async () => {
    // `handler()` runs on anything unexpected that is not the session — here,
    // `verifyCredentials`'s own lookup failing, which by its own comment
    // "throws nothing of its own" and lets a database failure propagate.
    // Whoever is on the other end of the login has typed nothing that could be
    // wrong yet, so a Postgres error naming a table or a column must not become
    // the sentence this endpoint answers with — that is half of what an
    // injection attempt needs to know, handed to it for free by a request that
    // only had to be malformed or badly timed.
    //
    // 500 here and 503 above, and the pair is deliberate: this is the software
    // failing somewhere it did not expect to, that is a named dependency being
    // down. Whoever reads the log needs to be able to tell them apart.
    const dbError = new Error(
      'null value in column "pass" of relation "usuarios" violates not-null constraint',
    );
    findOne.mockRejectedValue(dbError);

    const c = call({ user: "isaias", pass: "secreta" });
    await login(c.req, c.res);

    expect(c.status).toBe(500);
    // Not merely "does not contain the word column" — the exact old failure
    // mode was handing back `error.message` verbatim, so the test that would
    // survive that regression is one comparing against the real message.
    expect(c.payload?.message).not.toBe(dbError.message);
    expect(c.payload?.message).not.toContain("usuarios");
    expect(c.payload?.message).not.toContain("column");
    // The detail is not thrown away, only kept off the wire: it still has to
    // reach whoever can act on a database outage.
    expect(error).toHaveBeenCalled();
  });

  it("opens nothing when the credential is wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const c = call({ user: "isaias", pass: "equivocada" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    expect(c.cookieCall).toBeUndefined();
  });

  it("opens nothing when the request never had a username in it", async () => {
    const c = call({ pass: "secreta" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
