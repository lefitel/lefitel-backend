// The session endpoints through the real Express stack.
//
// The controller tests build a `req` by hand, which is fast and blind in one
// specific way: they trust that the fake object looks like what the middleware
// chain actually produces. It does not always. In the previous task a test just
// like this one was the only thing that caught a 500 on *every* protected route
// — `cookie-parser` runs its own `JSONCookies` step and turns a value like `j:1`
// into the number `1` before anything downstream sees it, which no hand-built
// `req.cookies` ever does.
//
// So this file goes in through `supertest`: real cookie-parser, real
// `express.json`, real helmet, real `authenticate`, real `sessionStore`, real
// controllers. The only thing replaced is the handful of query methods on the
// two models, which means no Postgres and no fixture data — and, more to the
// point, it means the `where` clause the store hands the model is readable from
// here.
//
// That last part is what makes this the strongest test of the IDOR: `DELETE
// /api/auth/sessions/:id` is asserted not by trusting a mocked store's answer,
// but by reading the actual query and checking the caller's own `id_usuario` is
// in it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const permisos = { seguridad: { ver: true, crear: false } };
vi.mock("./permissions/store.js", () => ({
  permissionsFor: async () => permisos,
  can: async () => false,
  invalidatePermissions: vi.fn(),
}));
vi.mock("./utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));

const app = (await import("./app.js")).default;
const { SESSION_COOKIE_NAME } = await import("./auth/sessionCookie.js");
const { allowedOrigins, CSRF_CLIENT_HEADER } = await import("./config/security.js");
const { hashSessionToken } = await import("./auth/sessionToken.js");
const { UsuarioModel } = await import("./models/usuario.model.js");
const { SesionModel } = await import("./models/sesion.model.js");

/**
 * The models are real, and only their four query methods are replaced.
 *
 * `vi.mock` on a model module cannot be used here, and finding out why is worth
 * a note: six other model modules declare `UsuarioModel.hasMany(...)` and
 * `PosteModel.belongsTo(UsuarioModel, ...)` while being imported, `app.ts`
 * imports every router so all of them run, and Sequelize checks its argument —
 * "poste.belongsTo called with something that's not a subclass of
 * Sequelize.Model". Spying on the real classes keeps every association intact
 * and still means no query ever leaves for Postgres.
 */
const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionFindAll = vi.spyOn(SesionModel, "findAll");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const sesionCreate = vi.spyOn(SesionModel, "create");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const usuarioFindOne = vi.spyOn(UsuarioModel, "findOne");

const YO = 7;
const MI_ROL = 2;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const MI_SESION = "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa";
const AJENA = "ffffffff-99ab-4999-8999-ffffffffffff";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;

/**
 * What the browser sends alongside the cookie, and what these requests would be
 * refused for lacking.
 *
 * `requireSameOrigin` turns a write that arrives with a session cookie and
 * cannot show it came from our own frontend into a 403 before it reaches any
 * controller, so every cookie-carrying write below has to look like the request
 * a browser actually makes: an `Origin` this API knows, and a header no
 * cross-site form can attach. Read off `allowedOrigins` rather than written out,
 * so the value is the one the app is really configured with, whatever
 * CORS_ORIGIN says in this environment.
 */
const DEL_FRONTEND = {
  Origin: allowedOrigins(process.env.CORS_ORIGIN)[0],
  [CSRF_CLIENT_HEADER]: "web",
};

beforeEach(() => {
  vi.clearAllMocks();
  // A live session belonging to YO. `last_used_at` is now on purpose: the touch
  // is throttled, so a fresh timestamp keeps `touchSession` from firing and
  // adding an UPDATE that the assertions below would read as theirs.
  sesionFindOne.mockResolvedValue({
    dataValues: {
      id: MI_SESION,
      id_usuario: YO,
      expires_at: new Date(Date.now() + 86_400_000),
      last_used_at: new Date(),
    },
  } as never);
  sesionFindAll.mockResolvedValue([] as never);
  sesionUpdate.mockResolvedValue([1] as never);
  sesionCreate.mockResolvedValue({ dataValues: {} } as never);
  usuarioFindByPk.mockResolvedValue({
    dataValues: { id: YO, id_rol: MI_ROL, user: "isaias", name: "Isaias", lastname: "Salas", image: null },
  } as never);
  usuarioFindOne.mockResolvedValue({
    dataValues: {
      id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
      name: "Isaias", lastname: "Salas", image: null, failed_attempts: 0, locked_until: null,
    },
  } as never);
});

/** The `where` of the nth UPDATE the store sent to the sessions table. */
const updateWhere = (n = 0) =>
  (sesionUpdate.mock.calls[n]?.[1] as { where: Record<string, unknown> } | undefined)?.where;

describe("the six session routes are really mounted", () => {
  it("answers every one of them, and none of them with a 500", async () => {
    // A mount path typed wrong gives 404 on all six at once, and a middleware
    // missing gives 500 on all six at once. Both are one-line mistakes that no
    // unit test with a hand-built `req` can see, because there is no mount in a
    // unit test.
    const calls: [string, number][] = [
      ["POST /api/auth/login", (await request(app).post("/api/auth/login").send({})).status],
      ["GET /api/auth/me", (await request(app).get("/api/auth/me")).status],
      ["POST /api/auth/logout", (await request(app).post("/api/auth/logout")).status],
      ["POST /api/auth/logout-all", (await request(app).post("/api/auth/logout-all")).status],
      ["GET /api/auth/sessions", (await request(app).get("/api/auth/sessions")).status],
      [
        "DELETE /api/auth/sessions/:id",
        (await request(app).delete(`/api/auth/sessions/${MI_SESION}`)).status,
      ],
    ];

    for (const [route, status] of calls) {
      expect(status, route).not.toBe(404);
      expect(status, route).not.toBe(500);
    }
    // Logging in is the only one that does not need a credential; the other five
    // refuse without one.
    expect(calls[0][1]).toBe(400);
    for (const [route, status] of calls.slice(1)) {
      expect(status, route).toBe(401);
    }
  });
});

describe("logging in, through the real stack", () => {
  it("sets an httpOnly cookie and puts no token in the body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    const setCookie = (res.headers["set-cookie"] as unknown as string[])?.join("; ") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    // The attributes a browser will actually enforce, read off the wire rather
    // than off the call site.
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    // And the thing this endpoint exists for: nothing usable in the body.
    expect(res.body.usuario).not.toHaveProperty("token");
    expect(JSON.stringify(res.body)).not.toContain("token");
    expect(res.body.permisos).toEqual(permisos);
  });
});

describe("who the cookie says I am", () => {
  it("hashes the cookie it was sent and looks the session up by the hash", async () => {
    // The token never reaches the database. This is where that stops being a
    // claim in a comment: the value on the wire and the value in the query are
    // compared here.
    await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    const where = (sesionFindOne.mock.calls[0][0] as { where: { token_hash: string } }).where;
    expect(where.token_hash).toBe(hashSessionToken(TOKEN));
    expect(where.token_hash).not.toBe(TOKEN);
  });

  it("answers with the role and the permissions read from the database", async () => {
    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.usuario).toMatchObject({ id: YO, id_rol: MI_ROL, user: "isaias" });
    expect(res.body.permisos).toEqual(permisos);
  });

  it("refuses, rather than 500s, a cookie cookie-parser has parsed as JSON", async () => {
    // The defect a unit test could not see, kept here on the new routes too:
    // `osefi_session=j:1` arrives as the number 1, not a string.
    const res = await request(app).get("/api/auth/me").set("Cookie", `${SESSION_COOKIE_NAME}=j:1`);
    expect(res.status).toBe(401);
  });
});

describe("closing sessions, through the real stack", () => {
  it("revokes exactly this session on logout and takes the cookie back", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(200);
    // `id_usuario` in a logout too. It is not needed there — the caller's own
    // session id came from their own cookie — but there is one way to revoke a
    // session in this codebase and the owner is not optional in it.
    expect(updateWhere()).toEqual({ id: MI_SESION, id_usuario: YO, revoked_at: null });
    const setCookie = (res.headers["set-cookie"] as unknown as string[])?.join("; ") ?? "";
    // Cleared by being set to nothing with an expiry in the past — which is the
    // only way to remove a cookie — so the name must be there with an empty
    // value.
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it("puts the caller's own id_usuario in the DELETE, not only the id from the URL", async () => {
    // The IDOR assertion, read off the real query. Written any other way — a
    // mocked store, or checking only the status — removing `id_usuario` from
    // `revokeSessionOf`'s `where` would leave this file green while any account
    // with a session could close anybody else's.
    const res = await request(app)
      .delete(`/api/auth/sessions/${AJENA}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(200);
    expect(updateWhere()).toEqual({ id: AJENA, id_usuario: YO, revoked_at: null });
  });

  it("answers 404, not 403 and not 500, when the row was somebody else's", async () => {
    sesionUpdate.mockResolvedValue([0] as never);
    const res = await request(app)
      .delete(`/api/auth/sessions/${AJENA}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(404);
    // The filter still went to the database — the 404 is the query finding
    // nothing, not a check that skipped it.
    expect(updateWhere()).toMatchObject({ id_usuario: YO });
  });

  it("never sends a malformed id to a UUID column", async () => {
    // `WHERE id = 'pepito'` on a `uuid` column is not "no rows", it is Postgres
    // error 22P02. Without the shape check this would be a 500 with a stack
    // trace in the log, produced on demand by any account with a session.
    const res = await request(app)
      .delete("/api/auth/sessions/pepito")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(404);
    expect(sesionUpdate).not.toHaveBeenCalled();
  });

  it("revokes everything the caller has on logout-all", async () => {
    sesionUpdate.mockResolvedValue([3] as never);
    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(200);
    expect(res.body.cerradas).toBe(3);
    // By user, and with nothing spared: this is the one that has to be all of
    // them.
    expect(updateWhere()).toEqual({ id_usuario: YO, revoked_at: null });
  });
});

describe("logging in twice from the same browser", () => {
  it("closes the row the browser was already holding before opening the next", async () => {
    // Through the real stack, so the cookie really travels and the real
    // `findLiveSession` really hashes it. Without this rotation the current
    // frontend — which never calls logout — leaves one live row per login
    // forever, all with the same user_agent and IP, which is what would make
    // `GET /auth/sessions` useless as a screen.
    const res = await request(app)
      .post("/api/auth/login")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    // The previous row, revoked, by id and owner.
    expect(updateWhere()).toEqual({ id: MI_SESION, id_usuario: YO, revoked_at: null });
    // And a new row written all the same.
    expect(sesionCreate).toHaveBeenCalledTimes(1);
  });

  it("opens the session without any revocation when the browser had no cookie", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    expect(sesionUpdate).not.toHaveBeenCalled();
    expect(sesionCreate).toHaveBeenCalledTimes(1);
  });
});

describe("the session list", () => {
  it("asks only for the caller's own rows and marks the current one", async () => {
    sesionFindAll.mockResolvedValue([
      {
        dataValues: {
          id: MI_SESION, id_usuario: YO, user_agent: "Chrome", ip_address: "1.2.3.4",
          created_at: new Date(), last_used_at: new Date(),
          expires_at: new Date(Date.now() + 86_400_000), revoked_at: null,
        },
      },
    ] as never);
    const res = await request(app).get("/api/auth/sessions").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    const where = (sesionFindAll.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id_usuario: YO, revoked_at: null });
    expect(res.body.sesiones[0]).toMatchObject({ id: MI_SESION, actual: true });
    expect(JSON.stringify(res.body)).not.toContain("token_hash");
  });
});
