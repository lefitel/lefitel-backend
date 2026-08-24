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
import jwt from "jsonwebtoken";
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
const { allowedOrigins, CSRF_CLIENT_HEADER, PASSWORD_CONFIRM_LIMIT, SESSION_ABSOLUTE_DAYS, SESSION_IDLE_DAYS, SESSION_TOUCH_THROTTLE_MINUTES } =
  await import("./config/security.js");

/**
 * The two response header names the frontend hard-codes, written out here.
 *
 * Not `ROLE_HEADER` and `SESSION_EXPIRES_HEADER` imported from the config, and
 * that is deliberate — see the same literals and the longer reasoning in
 * `app.security.test.ts`. In short: an expectation built from the constant it
 * is checking moves with a rename, so it can only ever catch a deletion, and
 * renaming `ROLE_HEADER` used to leave every test in both repositories green
 * while the browser silently stopped noticing role changes.
 */
const CABECERA_ROL = "x-osefi-role";
const CABECERA_VENCIMIENTO = "x-osefi-session-expires";
const { hashSessionToken } = await import("./auth/sessionToken.js");
const { loginIpLimiter, loginAccountIpLimiter, passwordConfirmLimiter } = await import(
  "./middleware/loginLimiters.js"
);
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
  Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0],
  [CSRF_CLIENT_HEADER]: "web",
};
/**
 * `DEL_FRONTEND.Origin` typed as definitely present: this suite's `.env`
 * always configures `CORS_ORIGIN` (see `app.auth.test.ts`'s sibling
 * `csrf.test.ts` for the same note), so the list is never empty here.
 */
const ORIGIN_NUESTRO = DEL_FRONTEND.Origin as string;

/**
 * The live session's own `expires_at`, captured rather than inlined so a test
 * can assert `GET /api/auth/me` answers with this exact value — the one the
 * row actually has — and not a date some handler computed on its own.
 */
let SESION_EXPIRA_FILA: Date;
/**
 * When the session was opened, which is what the absolute ceiling is measured
 * from. Recent on purpose: `authenticate` now reports the *effective* expiry —
 * the row's own, never later than `created_at` plus `SESSION_ABSOLUTE_DAYS` —
 * so a session created moments ago is the case where the two coincide and
 * `SESION_EXPIRA_FILA` is the answer. The tests that need them to differ move
 * this back themselves.
 */
let SESION_CREADA: Date;
const DIA_MS = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  SESION_EXPIRA_FILA = new Date(Date.now() + DIA_MS);
  SESION_CREADA = new Date();
  // A live session belonging to YO. `last_used_at` is now on purpose: the touch
  // is throttled, so a fresh timestamp keeps `touchSession` from firing and
  // adding an UPDATE that the assertions below would read as theirs.
  sesionFindOne.mockResolvedValue({
    dataValues: {
      id: MI_SESION,
      id_usuario: YO,
      created_at: SESION_CREADA,
      expires_at: SESION_EXPIRA_FILA,
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

  it("hands out no credential in the body on the old address either", async () => {
    /**
     * The address the current frontend posts to, through the mount that
     * actually serves it — and the test this task exists for.
     *
     * `POST /api/login` used to answer with a signed seven-day JWT nested
     * inside `usuario`. That token had no session row behind it, so nothing
     * could revoke it: neither a password change nor "cerrar todas mis
     * sesiones" reached it, and it stayed a working credential until it
     * expired. It also sat where any script on the page could read it. Both
     * facts are why `jwt.sign` is gone from the repository.
     *
     * Asserted through `supertest` rather than by calling the handler,
     * because the handler is no longer the thing that could go wrong: it is
     * shared with `POST /api/auth/login` and pinned by the test above. What
     * this address can still get wrong is its **wiring** — `login.routes.ts`
     * pointing back at a handler that signs, or a well-meant "compatibility"
     * shim putting the field back for a frontend that has not needed it in
     * two plans. Only a request through the real mount sees that.
     *
     * The two bodies are compared field for field rather than each being
     * checked for the absence of a token. "No token here" is the assertion
     * this project has repeatedly watched pass against broken code; "the same
     * answer, whichever address you use" is the property actually meant, and
     * it fails for a shim that adds anything at all.
     */
    const vieja = await request(app)
      .post("/api/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(vieja.status).toBe(200);
    // The cookie is the credential, on this address as much as the other.
    const setCookie = (vieja.headers["set-cookie"] as unknown as string[])?.join("; ") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toMatch(/HttpOnly/i);

    expect(vieja.body.usuario).not.toHaveProperty("token");
    expect(Object.keys(vieja.body).sort()).toEqual(["message", "permisos", "usuario"]);
    for (const palabra of ["token", "jwt", "bearer"]) {
      expect(JSON.stringify(vieja.body).toLowerCase(), palabra).not.toContain(palabra);
    }
    // And it really did log somebody in, rather than passing every line above
    // by answering an empty object.
    expect(vieja.body.usuario).toMatchObject({ id: YO, id_rol: MI_ROL, user: "isaias" });
    expect(vieja.body.permisos).toEqual(permisos);

    const nueva = await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(nueva.status).toBe(vieja.status);
    expect(nueva.body).toEqual(vieja.body);
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
    // Through the real stack, not the hand-built req/res of
    // auth.controller.test.ts: this is what proves authenticate really hands
    // this session's own expires_at to req.user, over the real middleware
    // chain, and that `me` really forwards it rather than the wiring silently
    // dropping it somewhere in between.
    expect(res.body.expires_at).toBe(SESION_EXPIRA_FILA.toISOString());
    // Same proof for the role header: set by authenticate, and only readable
    // by the browser because app.ts's exposedHeaders names it — a unit test
    // with a fake `res.setHeader` cannot see either half of that. The name is
    // the hand-written literal, not the constant: see its comment at the top.
    expect(res.headers[CABECERA_ROL]).toBe(String(MI_ROL));
    // And the expiry, on the header as well as in the body, in the format the
    // other repository parses with `new Date(...)`.
    expect(res.headers[CABECERA_VENCIMIENTO]).toBe(SESION_EXPIRA_FILA.toISOString());
  });

  it("puts the expiry on an answer that has no body to carry it", async () => {
    // The reason this is a header at all. The server slides a session on any
    // authenticated request, not only on the ones that answer 200 with JSON a
    // client can read — so a client that learns the deadline from `/auth/me`
    // alone spends the rest of the day counting down to an instant that has
    // already moved. `authenticate` is middleware, so this rides on whatever
    // the route underneath answers: here a 404 from a path with no route.
    //
    // Not a path under `/api/auth`, and the difference is the point of picking
    // this one: that router mounts no `authenticate` of its own — `POST
    // /auth/login` cannot ask for a credential it is there to produce — so each
    // of its routes declares the middleware itself and a path that matches none
    // of them never authenticates at all. `/api/permisos` is mounted the
    // ordinary way, with `authenticate` in front of the whole router, which is
    // how every other router in this app is mounted and therefore what this has
    // to be true of.
    const res = await request(app).get("/api/permisos/no-existe").set("Cookie", COOKIE);

    expect(res.status).toBe(404);
    expect(res.headers[CABECERA_VENCIMIENTO]).toBe(SESION_EXPIRA_FILA.toISOString());
  });

  it("never promises a day past the thirty-day ceiling the query enforces", async () => {
    // The production case, measured. `touchSession` used to write a bare
    // `now + SESSION_IDLE_DAYS` with no ceiling, so from day twenty-three of a
    // session used every day the row's `expires_at` runs ahead of the day
    // `findLiveSession` starts refusing it — by up to a week. Somebody who
    // uses the ERP daily and never logs out then loses the session mid-morning
    // on day thirty with **no five-minute warning at all**, because the page
    // believed it had days left, and whatever form was open goes with it.
    //
    // A row in exactly that state: opened twenty-nine days ago, claiming five
    // more days, used a moment ago so nothing is touched. The ceiling is
    // tomorrow, and tomorrow is what the client has to be told.
    const creada = new Date(Date.now() - 29 * DIA_MS);
    const techo = new Date(creada.getTime() + SESSION_ABSOLUTE_DAYS * DIA_MS);
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION,
        id_usuario: YO,
        created_at: creada,
        expires_at: new Date(Date.now() + 5 * DIA_MS),
        last_used_at: new Date(),
      },
    } as never);

    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.headers[CABECERA_VENCIMIENTO]).toBe(techo.toISOString());
    expect(res.body.expires_at).toBe(techo.toISOString());
  });

  it("reports the window this request just opened, not the one it found", async () => {
    // The other half of the same defect, and the one that throws somebody out
    // of a live session. `authenticate` used to copy the `expires_at`
    // `findLiveSession` had read — the value from *before* the touch this very
    // request performs. Somebody who used the ERP last Monday and opens it the
    // next Monday with ten minutes left on the row is given another seven days
    // by the server and told "ten minutes" by it: five minutes later the
    // warning fires, five after that the timer logs them out, and the session
    // was alive the whole time. The error is not bounded by the throttle — it
    // is bounded by how long the person stayed away.
    const creada = new Date(Date.now() - 7 * DIA_MS);
    const usadaHaceMucho = new Date(Date.now() - (SESSION_TOUCH_THROTTLE_MINUTES + 1) * 60_000);
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION,
        id_usuario: YO,
        created_at: creada,
        expires_at: new Date(Date.now() + 10 * 60_000),
        last_used_at: usadaHaceMucho,
      },
    } as never);

    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    // Seven days from now, give or take the milliseconds this request took.
    const prometido = new Date(res.headers[CABECERA_VENCIMIENTO] as string).getTime();
    const esperado = Date.now() + SESSION_IDLE_DAYS * DIA_MS;
    expect(Math.abs(prometido - esperado)).toBeLessThan(5_000);
    // One value, four destinations: the header, the body, the row that was just
    // written, and the cookie the browser is handed back. Computed separately
    // they drift the day one of them is edited.
    expect(res.body.expires_at).toBe(new Date(prometido).toISOString());
    const escrito = (sesionUpdate.mock.calls[0]?.[0] as { expires_at?: Date }).expires_at;
    expect(escrito?.toISOString()).toBe(new Date(prometido).toISOString());
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).join("; ");
    expect(setCookie).toContain(new Date(prometido).toUTCString());
  });

  it("refuses, rather than 500s, a cookie cookie-parser has parsed as JSON", async () => {
    // The defect a unit test could not see, kept here on the new routes too:
    // `osefi_session=j:1` arrives as the number 1, not a string.
    const res = await request(app).get("/api/auth/me").set("Cookie", `${SESSION_COOKIE_NAME}=j:1`);
    expect(res.status).toBe(401);
  });
});

describe("the credential that is no longer one", () => {
  /**
   * The tripwire for the whole plan, through the whole stack.
   *
   * Until this task `authenticate` had a second door: no cookie and an
   * `Authorization: Bearer` header meant "verify this JWT and let the account
   * in". A token verified that way has no session row behind it, so nothing
   * could revoke it — not `logout`, not `logout-all`, not a password change,
   * not archiving the account. Every other task in this arc built the row;
   * closing that door is what makes the row the only way in, and these two
   * tests are what fail if it is ever reopened.
   *
   * **The token is signed for real, with this app's own configured key.** That
   * is the difference between a test and a decoration. `Bearer no-es-un-jwt`
   * answers 401 too — for being malformed — and would go on answering 401 with
   * the old path fully restored, which is exactly the Plan 1 trap where a UUID
   * of nothing but digits made the lower-casing step untestable. `JWT_SECRET`
   * is read from the environment rather than written out here, so it is the
   * same string a re-added `jwt.verify(token, process.env.JWT_SECRET)` would
   * check the signature against. The mocked `UsuarioModel.findByPk` answers
   * with account 7, so a restored path would find the account, set the role
   * header and answer 200.
   */
  const firmado = () => {
    const secret = process.env.JWT_SECRET as string;
    // Not a formality: with no `.env` this would be `undefined`, `jwt.sign`
    // would throw, and the two tests below would fail for a reason that has
    // nothing to do with what they are about.
    expect(secret, "JWT_SECRET tiene que estar configurado para que este test pruebe algo").toBeTruthy();
    const token = jwt.sign({ id: YO, id_rol: MI_ROL }, secret);
    expect(jwt.verify(token, secret)).toMatchObject({ id: YO });
    return token;
  };

  it("opens nothing at GET /api/auth/me", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${firmado()}`);

    expect(res.status).toBe(401);
    // No role header and no expiry header: both are set by `authenticate` on a
    // request it let through, so their absence is the same fact as the 401 seen
    // from the browser's side, and a restored bearer path would set both.
    expect(res.headers[CABECERA_ROL]).toBeUndefined();
    expect(res.headers[CABECERA_VENCIMIENTO]).toBeUndefined();
    // Nothing was even looked up. This is what separates "no credential was
    // read" from "a credential was read and refused", and it is what the old
    // path could not have satisfied: it queried the account named in the token.
    expect(usuarioFindByPk).not.toHaveBeenCalled();
    expect(sesionFindOne).not.toHaveBeenCalled();

    // The premise, measured rather than assumed: the same address answers 200
    // to the credential that still works, so the 401 above is about the header
    // and not about this endpoint being broken.
    const conCookie = await request(app).get("/api/auth/me").set("Cookie", COOKIE);
    expect(conCookie.status).toBe(200);
  });

  it("opens nothing at POST /api/auth/logout-all, the endpoint this arc exists for", async () => {
    // The sharpest version of the same test. `logout-all` revokes by user id, so
    // the old path could reach it: a request on a bearer token really did close
    // every session row of that account — while its own credential went on
    // working, which is the hole this plan documents. It cannot reach it now.
    //
    // A write, so it also passes through `requireSameOrigin` with no cookie and
    // no `Origin`: 401 and not 403 says the CSRF guard stayed out of the way and
    // `authenticate` is what refused this, which is the correct division of
    // labour for a request that carries no cookie at all.
    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${firmado()}`);

    expect(res.status).toBe(401);
    // And the thing that matters more than the status: no session of anybody's
    // was touched. A revocation reached by an unrevocable credential is the
    // exact shape of the defect.
    expect(sesionUpdate).not.toHaveBeenCalled();
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
    // `findLiveSession` really hashes it. Without this rotation, every login
    // that was not preceded by somebody pressing the logout button — closing
    // the tab, or a logout request that failed and was left on screen for
    // somebody to retry — leaves one more live row for a week, all with the
    // same user_agent and IP, which is what would make `GET /auth/sessions`
    // useless as a screen.
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

/**
 * What Task 8's own live verification could not check by itself.
 *
 * That verification ran `curl -i` against a booted server for exactly the
 * login → me → logout and logout-all cycle below, and `curl` sends whatever
 * headers it is told and prints whatever comes back — it does not decide
 * anything from them. A real browser does: `Access-Control-Allow-Credentials`
 * and `Access-Control-Allow-Origin` are what it reads to decide whether to
 * keep a cross-origin `Set-Cookie` at all and whether to let the page's own
 * script see the response. A `curl` transcript showing 200 and a cookie
 * cannot tell that story apart from one a browser would have discarded on the
 * spot — only reading these two headers, through the real CORS middleware,
 * can.
 */
describe("what curl could not check live: whether a browser would keep the credential", () => {
  it("carries both CORS-credential headers at every step of the cycle this task verifies live", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .set(DEL_FRONTEND)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    const me = await request(app).get("/api/auth/me").set("Cookie", COOKIE).set(DEL_FRONTEND);
    const logout = await request(app).post("/api/auth/logout").set("Cookie", COOKIE).set(DEL_FRONTEND);
    const logoutAll = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    for (const [route, res] of [
      ["POST /api/auth/login", login],
      ["GET /api/auth/me", me],
      ["POST /api/auth/logout", logout],
      ["POST /api/auth/logout-all", logoutAll],
    ] as const) {
      expect(res.headers["access-control-allow-credentials"], route).toBe("true");
      expect(res.headers["access-control-allow-origin"], route).toBe(ORIGIN_NUESTRO);
    }
  });

  it("withholds the matching allow-origin from an origin that is not ours, on the very endpoint that revokes every session", async () => {
    // `logout-all` is the endpoint this whole plan exists to make possible —
    // revocation the old JWT never had. If a hostile origin could read its
    // response, it could confirm a stolen cookie had just killed every one of
    // the victim's live sessions.
    //
    // `cors()` here is configured with a bare `credentials: true` — a single
    // boolean, not a function of the origin — so it stamps
    // `Access-Control-Allow-Credentials: true` on *every* response, this one
    // included, whatever `Origin` asked. That header alone changes nothing:
    // per the Fetch spec, a credentialed cross-origin response is only
    // readable when `Access-Control-Allow-Origin` also names the exact
    // requesting origin, and a wildcard does not count. `allowedOrigins`
    // never puts `evil-osefi.net` in that list, so `cors()` sends no
    // `Access-Control-Allow-Origin` at all for it — and that absence, on its
    // own, is what makes a browser hide the response from the page that
    // asked, whatever status code Express sent underneath.
    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", COOKIE)
      .set("Origin", "https://evil-osefi.net")
      .set(CSRF_CLIENT_HEADER, "web");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
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

describe("confirming your own password, through the real stack", () => {
  /**
   * The endpoint that replaced "call the login and see whether it works".
   *
   * What only a request through the mount can see is the wiring, and there are
   * four wires here: `authenticate` in front of it (without which any stranger
   * could ask), `requireSameOrigin` in front of that (without which any page on
   * the internet could ask through somebody's browser), the rate limiter behind
   * `authenticate` and not in front of it, and the absence of everything the old
   * implementation emitted — a `Set-Cookie`, a session row, a bitácora line
   * claiming somebody logged in.
   */
  const CLAVE = `pc:${YO}`;

  /**
   * The bucket is a module singleton shared with the real app, so each test
   * starts with the caller's budget full. Without this the sixth request in
   * this describe would be a 429 wherever it happened to fall.
   */
  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE);
  });

  it("is mounted, and refuses without a session cookie", async () => {
    const res = await request(app).post("/api/auth/confirm-password").send({ pass: "x" });

    // Not 404: the route exists. Not 500: nothing in the chain threw.
    expect(res.status).toBe(401);
    // Pinned on the reason and not only the number, because 401 is reachable
    // from three places on this path — no cookie, a dead session, an archived
    // account — and a test that reads the number alone passes for a route
    // mounted without `authenticate` that happens to answer 401 for its own
    // reasons. This is `authenticate`'s own sentence.
    expect(res.body.message).toBe("Su sesión expiró. Vuelva a iniciar sesión.");
    // And nothing was compared: no password check ran at all.
    expect(usuarioFindByPk).not.toHaveBeenCalled();
  });

  it("refuses a cookie-carrying request that cannot show it came from our own frontend", async () => {
    // Without this, a page on any other site could put somebody's password to
    // this endpoint through their own browser — cookies and all — and read the
    // answer off the response's timing or the count of failures in the bitácora.
    // `requireSameOrigin` runs before the router, so the request never reaches
    // the handler.
    const res = await request(app)
      .post("/api/auth/confirm-password")
      .set("Cookie", COOKIE)
      .send({ pass: "una-clave-de-prueba" });

    expect(res.status).toBe(403);
    expect(usuarioFindByPk).not.toHaveBeenCalled();
  });

  it("says yes without issuing anything: no cookie, no session row, no bitácora line", async () => {
    const { logAction } = await import("./utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    /**
     * A row carrying a hash, for this test only.
     *
     * The shared fixture in `beforeEach` has no `pass` — it is written for
     * `authenticate`, which asks for two columns — and with `bcryptjs.compare`
     * mocked to resolve true, this test would have said "correcta: true" while
     * the endpoint compared against `undefined`. Which is the whole family of
     * mistake this file exists to catch, so the hash is put back and the
     * comparison itself is asserted below.
     */
    usuarioFindByPk.mockResolvedValue({
      dataValues: {
        id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
        name: "Isaias", lastname: "Salas", image: null, failed_attempts: 0, locked_until: null,
      },
    } as never);

    const res = await request(app)
      .post("/api/auth/confirm-password")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ correcta: true });
    // The four effects of the old implementation, one assertion each.
    //
    // No `Set-Cookie` at all, and that is not luck: `beforeEach` gives the
    // session a fresh `last_used_at`, so the sliding renewal is throttled off
    // and the only thing that could set a cookie here is somebody opening a
    // session. Which is the thing being asserted against.
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(sesionCreate).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
    // Read by the caller's own id, from the cookie's session, and not by
    // anything in the body.
    expect(usuarioFindByPk).toHaveBeenCalledWith(YO);
    // And it really compared what arrived against what is stored, rather than
    // answering yes off a row it never read a hash out of.
    expect(bcryptjs.compare).toHaveBeenCalledWith("una-clave-de-prueba", "$2a$12$hash");
  });

  it("says no in the body, with a 200, and charges the account nothing", async () => {
    /**
     * The break-it test of this task: make the endpoint answer "correcta" always
     * and this is what falls.
     *
     * It asserts the **field**, not the status, and that is deliberate — this
     * endpoint answers 200 either way, so a status assertion would pass for both
     * answers. The plan has already been caught by the other version of this
     * mistake once, a `toBe(401)` that stayed green with a broken branch
     * restored because something else on the path answered 401 too.
     *
     * `increment` is stubbed for this one case rather than left real. The
     * wrong-password branch of the *login* calls it, which is why the comment at
     * the end of this file says a test that reached that branch really did send
     * an UPDATE to whatever `.env` points at; the confirmation branch must not
     * call it at all, and stubbing it is what turns a regression to the lockout
     * policy into the failed assertion below instead of a write against a real
     * database.
     */
    const usuarioIncrement = vi.spyOn(UsuarioModel, "increment").mockResolvedValue([[], 0] as never);
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    // With a hash on the row, for the reason spelled out in the test above: on
    // the shared fixture the comparison would be against `undefined`, and then
    // "correcta: false" would also be what a handler that never compares
    // anything answers.
    usuarioFindByPk.mockResolvedValue({
      dataValues: {
        id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
        name: "Isaias", lastname: "Salas", image: null, failed_attempts: 0, locked_until: null,
      },
    } as never);
    try {
      const res = await request(app)
        .post("/api/auth/confirm-password")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: "no-es-la-suya" });

      expect(res.status).toBe(200);
      expect(res.body.correcta).toBe(false);
      // Nothing about the account, and a sentence that does not mention a
      // username the caller never sent.
      expect(res.body.message).toBe("Esa no es su contraseña actual.");
      // The "no" came out of a real comparison against the stored hash.
      expect(bcryptjs.compare).toHaveBeenCalledWith("no-es-la-suya", "$2a$12$hash");
      // The reason the whole endpoint exists: a typo while renaming yourself
      // must not spend a failed login attempt, because five of them shut the
      // account.
      expect(usuarioIncrement).not.toHaveBeenCalled();
    } finally {
      usuarioIncrement.mockRestore();
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("runs out of attempts long before it becomes a way of guessing a password", async () => {
    /**
     * The limit that replaces the lockout on this door, on the real mount and
     * against the real bucket.
     *
     * Somebody who has stolen a session cookie can ask this endpoint "is the
     * password X?" as often as it will answer, and a wrong answer here costs the
     * account nothing by design. `PASSWORD_CONFIRM_LIMIT` is therefore the whole
     * of the limit, and it is keyed by the account rather than the address so
     * that asking from twenty addresses is still one budget.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    try {
      const attempt = () =>
        request(app)
          .post("/api/auth/confirm-password")
          .set("Cookie", COOKIE)
          .set(DEL_FRONTEND)
          .send({ pass: "adivinando" });

      for (let i = 0; i < PASSWORD_CONFIRM_LIMIT; i++) {
        const res = await attempt();
        expect(res.status, `intento ${i + 1}`).toBe(200);
        expect(res.body.correcta, `intento ${i + 1}`).toBe(false);
      }

      const cortado = await attempt();
      expect(cortado.status).toBe(429);
      // And the refusal is not readable as an answer about the password. The
      // client requires `correcta === true`, so a 429 stops it dead — but a
      // body carrying `correcta: false` here would tell a guesser that this
      // particular attempt was wrong, which is exactly what the budget is
      // meant to stop them learning.
      expect(cortado.body).not.toHaveProperty("correcta");

      // The wrong password is what was charged for, not the answer's status: a
      // correct one costs a token from the same bucket, which is why nothing
      // here relies on `skipSuccessfulRequests`.
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
      const aunCortado = await attempt();
      expect(aunCortado.status).toBe(429);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("keeps one budget per account, not one for everybody", async () => {
    // A key generator that ignored `req.user` — or fell back to a constant —
    // would put the whole company in one bucket, and five attempts by one
    // person would lock the endpoint for everyone. The key is read out of the
    // bucket rather than inferred from a second caller's 200, because two
    // accounts cannot easily be signed in at once through this harness.
    await request(app)
      .post("/api/auth/confirm-password")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "una-clave-de-prueba" });

    const mio = (await passwordConfirmLimiter.getKey(CLAVE)) as { totalHits?: number } | undefined;
    expect(mio?.totalHits).toBe(1);
    // Nothing landed in an address-shaped bucket, which is what the fallback in
    // `passwordConfirmKey` would have produced had `req.user` not been read.
    expect(await passwordConfirmLimiter.getKey("pc:ip:::ffff:127.0.0.1")).toBeUndefined();
  });
});

describe("what a database outage costs the office's login budget", () => {
  /**
   * One address for these two, and not the loopback the rest of this file
   * arrives on, so the counters read below belong to these requests alone.
   * `app.ts` sets `trust proxy` to one hop, which is what makes
   * `X-Forwarded-For` the address the buckets key on.
   */
  const DESDE = "198.51.100.7";
  const CLAVE_IP = `ip:${DESDE}`;
  const claveCuenta = (user: string) => `ipu:${DESDE}:${user}`;

  /**
   * express-rate-limit refunds from the response's own `finish` handler, which
   * is asynchronous: without one turn of the event loop these assertions read
   * the counter mid-flight.
   */
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const hits = async (limiter: { getKey: (k: string) => unknown }, key: string) =>
    ((await limiter.getKey(key)) as { totalHits?: number } | undefined)?.totalHits;

  beforeEach(async () => {
    await loginIpLimiter.resetKey(CLAVE_IP);
  });

  it("spends nothing on the old door's 503, on the real mount", async () => {
    // The two halves joined: `loginLimiters.test.ts` proves a 5xx is refunded
    // and `login.session.test.ts` proves this failure answers 503, but only
    // this goes through the mount in `app.ts` with a real session store on top
    // of a broken table, which is the shape the outage actually has.
    //
    // What it is guarding against is a cascade, not a wrong number. Behind the
    // office's NAT this key is the whole building, so before the refund fifteen
    // people retrying — which the message tells them to do — reached the
    // hundred, and then nobody could log in until the quarter-hour window
    // expired, with the database already back.
    await loginAccountIpLimiter.resetKey(claveCuenta("isaias"));
    sesionCreate.mockRejectedValue(new Error("pool agotado"));

    const res = await request(app)
      .post("/api/login")
      .set("X-Forwarded-For", DESDE)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    await settled();

    expect(res.status).toBe(503);
    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(0);
    expect(await hits(loginAccountIpLimiter, claveCuenta("isaias"))).toBe(0);
  });

  it("spends nothing on the new address either, which answers the same 503", async () => {
    // The same outage on `POST /api/auth/login`. Both addresses share one pair
    // of buckets — `auth.routes.ts` mounts the very same middleware — so a rule
    // that covered only one of them would have left the other charging for
    // outages.
    //
    // They also answer the same status now, which they did not before this
    // task: this address gave 500, because `handler()` turned the rejection
    // into one, and the old address gave 503 from a catch of its own. Merging
    // the two onto one handler kept the 503. Asserting it *here*, on the real
    // mount, is what makes the refund rule and the status one fact rather than
    // two that happen to agree.
    await loginAccountIpLimiter.resetKey(claveCuenta("isaias"));
    sesionCreate.mockRejectedValue(new Error("pool agotado"));

    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", DESDE)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    await settled();

    expect(res.status).toBe(503);
    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(0);
    expect(await hits(loginAccountIpLimiter, claveCuenta("isaias"))).toBe(0);
  });

  // The other direction — that exempting this server's failures did not make a
  // guess cheaper — is pinned in `loginLimiters.test.ts` and not here: over the
  // whole 4xx range on `costsNothing` itself, and on the real mount by "puts a
  // POST through both buckets", which uses an empty password so it is refused
  // before anything is looked up. The version of that test which belonged here
  // reached the wrong-password branch of `verifyCredentials`, and that branch
  // calls `UsuarioModel.increment` — not one of the four query methods this file
  // replaces, so it really did send an UPDATE to whatever `.env` points at.
});

/**
 * The two reads the old front door left behind, and why the assertion is 404.
 *
 * `GET /api/login` verified a signed JWT off the `Authorization` header and
 * answered with the account's role and permissions — a second copy of what
 * `authenticate` does, with no session row behind it and nothing that could
 * revoke it. `GET /api/permisos/mias` answered with the caller's own permission
 * matrix. Both were replaced by `GET /api/auth/me`, which sends the account and
 * the matrix in one answer off the session cookie, and `web` stopped calling
 * either of them two plans ago.
 *
 * **404 and not 401, and the difference is the whole point.** A 401 says "I do
 * not know who you are", which invites a caller to try again with a better
 * credential; a 404 says "there is nothing at this address", which is the truth.
 * Getting that wrong is not hypothetical here: `authenticate` is mounted in
 * front of `permisoRoutes` in `app.ts`, so an *anonymous* request to
 * `/api/permisos/mias` answers 401 whether the route exists or not — a test
 * written without a credential would have passed identically before and after
 * the removal and asserted nothing at all.
 *
 * So both requests below carry a working session cookie, and each is paired
 * with a live address on the very same mount. Through `supertest` rather than by
 * calling a handler, because there is no handler left to call: what is under
 * test is the routing table, and the only thing that can see a routing table is
 * a request.
 */
describe("the two reads the old frontend stopped calling", () => {
  it("has nothing at GET /api/login, on a mount that still serves POST", async () => {
    const res = await request(app).get("/api/login").set("Cookie", COOKIE);
    expect(res.status).toBe(404);

    // `not.toBe(401)` is deliberately *not* written beside that line: `toBe(404)`
    // already excludes every other status, so a second assertion there could
    // never fail on its own and would only look like extra cover. What 401 needs
    // instead is a case that can really produce one, which is the two below.

    // The credential was good, so the 404 above cannot be read as a refusal.
    const me = await request(app).get("/api/auth/me").set("Cookie", COOKIE);
    expect(me.status).toBe(200);

    // And the mount is still there. Without this the test would also pass if
    // somebody deleted `app.use("/api/login", ...)` outright, which would take
    // `POST /api/login` down with it — the address a cached bundle still logs in
    // through, and the reason that one was kept when this one went.
    const post = await request(app)
      .post("/api/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    expect(post.status).toBe(200);
  });

  it("has nothing at GET /api/permisos/mias, and 401 there without a cookie", async () => {
    const res = await request(app).get("/api/permisos/mias").set("Cookie", COOKIE);
    expect(res.status).toBe(404);

    // The half that makes the line above mean anything, and the reason this test
    // carries a cookie at all. `authenticate` is mounted in front of
    // `permisoRoutes` in `app.ts`, so an anonymous request to this path answers
    // 401 whether the route exists or not — measured, not assumed: a version of
    // this test written without a cookie asserted 404 and got 401, and would
    // have gone green identically before and after the removal. Asserting the
    // 401 keeps that premise from being quietly withdrawn: take `authenticate`
    // off that mount and this line fails, and the 404 above stops proving what
    // it claims to.
    const anonima = await request(app).get("/api/permisos/mias");
    expect(anonima.status).toBe(401);

    // The sibling read on the same router, with the same cookie: 403, because
    // `can` is mocked false in this file and the route asks for `roles.ver`. That
    // is what separates "this address is gone" from "this whole router stopped
    // being mounted", which would answer 404 here too.
    const matriz = await request(app).get("/api/permisos/").set("Cookie", COOKIE);
    expect(matriz.status).toBe(403);
  });
});
