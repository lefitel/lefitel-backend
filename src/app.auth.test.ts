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
/**
 * What `can` answers. False for everything in this file — the caller is an
 * ordinary account reaching its own records — and read through a variable
 * rather than hard-coded so the one test that needs a permission holder can
 * flip it and put it back.
 */
let puede = false;
vi.mock("./permissions/store.js", () => ({
  permissionsFor: async () => permisos,
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));
vi.mock("./utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));

const app = (await import("./app.js")).default;
const { SESSION_COOKIE_NAME } = await import("./auth/sessionCookie.js");
const { allowedOrigins, CSRF_CLIENT_HEADER, LOCKOUT_AFTER_FAILURES, PASSWORD_CONFIRM_LIMIT, PASSWORD_MIN_LENGTH, SESSION_ABSOLUTE_DAYS, SESSION_IDLE_DAYS, SESSION_TOUCH_THROTTLE_MINUTES } =
  await import("./config/security.js");
/**
 * The two sentences the credential gates answer with, imported rather than
 * retyped.
 *
 * Both routes below answer more than one 4xx, and this project has been caught
 * four times by a test that read only the number: a 401 is also what
 * `authenticate` says, and a 400 is what a username that is not a string gets.
 * Pinning the sentence is what makes those tests fail for the right reason —
 * and importing it, rather than writing the Spanish out, is deliberate here for
 * the opposite reason to `CABECERA_ROL` below: this is a message shown to a
 * person, not a wire format two repositories have to agree on byte for byte.
 */
const { CURRENT_PASSWORD_REQUIRED_MESSAGE, CURRENT_PASSWORD_WRONG_MESSAGE } = await import(
  "./controllers/usuario.controller.js"
);
/**
 * The `/api/usuario` router itself, for the one assertion that is about the
 * mounted middleware chain rather than about a response. See "mounts the
 * permission guard before the budget on both routes".
 */
const usuarioRouter = (await import("./routes/usuario.routes.js")).default;
const { CODIGO_STEP_UP } = await import("./middleware/requireStepUp.js");

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
const { TokenUsoUnicoModel } = await import("./models/tokenUsoUnico.model.js");
const { CredencialWebauthnModel } = await import("./models/credencialWebauthn.model.js");
const { FactorTotpModel } = await import("./models/factorTotp.model.js");
const { CodigoRecuperacionModel } = await import("./models/codigoRecuperacion.model.js");

/**
 * The models are real, and only their query methods are replaced.
 *
 * `vi.mock` on a model module cannot be used here, and finding out why is worth
 * a note: six other model modules declare `UsuarioModel.hasMany(...)` and
 * `PosteModel.belongsTo(UsuarioModel, ...)` while being imported, `app.ts`
 * imports every router so all of them run, and Sequelize checks its argument —
 * "poste.belongsTo called with something that's not a subclass of
 * Sequelize.Model". Spying on the real classes keeps every association intact
 * and still means no query ever leaves for Postgres.
 *
 * `tokenUsoUnicoDestroy` joined this list once `login` started sweeping
 * `token_uso_unico` opportunistically on every successful login (see
 * `tokenStore.ts`). Without it, every "logging in, through the real stack"
 * test below would reach the real `TokenUsoUnicoModel.destroy` and fire a
 * genuine DELETE against whichever database this process is configured
 * with — the exact failure global-constraints.md #11 warns about, and the
 * reason this whole file exists to be checked for it.
 */
const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionFindAll = vi.spyOn(SesionModel, "findAll");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const sesionCreate = vi.spyOn(SesionModel, "create");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const usuarioFindOne = vi.spyOn(UsuarioModel, "findOne");
const tokenUsoUnicoDestroy = vi.spyOn(TokenUsoUnicoModel, "destroy");
/**
 * Two more spies, added for Task 4's routes specifically — nothing already
 * exercised in this file reached either method for real.
 *
 * `usuarioUpdate` is `verifyEmail`'s own write (`email_verified_at = now()`).
 * `tokenUsoUnicoUpdate` is what `consumirToken` calls underneath —
 * `/email/verify` never wraps it in a transaction (see
 * `email.controller.ts`'s own comment on why), so exercising it here through
 * the real `tokenStore.js` never opens one and stays safe under this file's
 * "spy on the model methods, never mock `database/sequelize.js`" rule (that
 * mock would break `sequelize.define(...)` for every model `app.ts` loads).
 *
 * Deliberately not extended to `/email/send`'s happy path: that handler opens
 * a real `sequelize.transaction()` on its very first write, and `crearToken`
 * opens a second one of its own — neither is reachable here without a real
 * database connection, which this file's models-only spying cannot prevent.
 * That path is covered instead by `email.controller.test.ts`, which mocks
 * `database/sequelize.js` directly and does not import `app.js` at all.
 */
const usuarioUpdate = vi.spyOn(UsuarioModel, "update");
const tokenUsoUnicoUpdate = vi.spyOn(TokenUsoUnicoModel, "update");
/**
 * Three more, added for Task 6's `requireStepUp`. `authenticate`'s default
 * session below satisfies that gate's window for almost every test in this
 * file, so these three are never actually reached except by the describe
 * block that puts the account back in the unsatisfied state on purpose —
 * but they still have to be spied rather than left real: `tieneAlgunFactor`
 * is a genuine query with no fixture data behind it here, and a route that
 * reached it unmocked would fail on a live connection this file's own header
 * promises none of its tests need.
 */
const passkeyCount = vi.spyOn(CredencialWebauthnModel, "count");
const totpCount = vi.spyOn(FactorTotpModel, "count");
const codigoCount = vi.spyOn(CodigoRecuperacionModel, "count");

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
  //
  // `mfa_satisfied_at` is `null` because that is what every session in
  // production actually has today — nothing writes this column yet. A
  // fix-round review caught an earlier version of this fixture claiming
  // "just now" instead, which made every `/username/:id` and
  // `/userpass/:id` test below pass only because `requireStepUp`'s window
  // check short-circuited around the gate entirely — a state that does not
  // exist outside this test file. With the real value restored, those tests
  // supply what the gate actually asks for: a `stepup_password` field on the
  // request, alongside whatever `oldPass` each was already testing.
  sesionFindOne.mockResolvedValue({
    dataValues: {
      id: MI_SESION,
      id_usuario: YO,
      created_at: SESION_CREADA,
      expires_at: SESION_EXPIRA_FILA,
      last_used_at: new Date(),
      estado: "completa",
      mfa_satisfied_at: null,
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
  tokenUsoUnicoDestroy.mockResolvedValue(0);
  usuarioUpdate.mockResolvedValue([1] as never);
  tokenUsoUnicoUpdate.mockResolvedValue([0, []] as never);
  // No factor registered, by default — matching every other fixture in this
  // file, which models an ordinary account under plan 4A.
  passkeyCount.mockResolvedValue(0);
  totpCount.mockResolvedValue(0);
  codigoCount.mockResolvedValue(0);
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

  it("sweeps token_uso_unico through the real model, not just the mocked store", async () => {
    // The only assertion in this file that would have caught the risk this
    // task's own wiring introduced: `auth.controller.test.ts` and
    // `login.session.test.ts` replace `tokenStore.js` wholesale, which proves
    // the controller calls it but not that the real module underneath still
    // reaches Postgres correctly. This request goes through the real
    // `tokenStore.js` and the real `TokenUsoUnicoModel` — only `destroy`
    // itself is spied — so a broken import path or a renamed model would
    // show up here even though the other two files stay green.
    await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(tokenUsoUnicoDestroy).toHaveBeenCalledOnce();
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
        estado: "completa",
        mfa_satisfied_at: null,
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
        estado: "completa",
        mfa_satisfied_at: null,
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

/**
 * Renaming your own account and changing your own password are both gated on
 * your password, they pay out of one bucket, and the bucket charges for exactly
 * one answer: the 401 that says the password was not theirs.
 *
 * Every part of that is a one-line mistake no unit test can see, because none
 * of it is in a handler. The gates themselves are pinned in
 * `usuario.controller.test.ts`; what is pinned here is the mount — that each
 * route really runs behind the budget, that it is one budget and not one each,
 * and which answers cost something.
 *
 * **Why they need a budget at all.** Both handlers compare a password, and a
 * wrong one deliberately does not move `failed_attempts` — so that mistyping
 * while renaming or re-passwording yourself cannot shut you out of the ERP.
 * Without these mounts the routes would compare an unlimited number of
 * passwords for whoever already holds a stolen session.
 *
 * `PUT /usuario/userpass/:id` is the older sin of the two: it has compared
 * `oldPass` since long before this plan, with no bucket anywhere, and its
 * oracle is the cleaner one — a guess sent with a new password that fails the
 * policy comes back 401 when the guess is wrong and 400 when it is right.
 *
 * **And that 400 is why the refund exists.** It is also what somebody is told
 * for typing a new password of eight characters, which is not a guess at
 * anything — the comparison already said yes — so charging for it meant the
 * legitimate work of changing your own password was what emptied the budget,
 * and emptied the rename's with it. See `confirmCostsNothing`.
 */
describe("changing your own credentials spends the budget for a wrong password, and for nothing else", () => {
  const CLAVE_RENOMBRE = `pc:${YO}`;
  const DEMASIADO_CORTA = `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;

  /**
   * express-rate-limit hands a refund back from the response's own `finish`
   * handler, which is asynchronous: supertest resolves before it runs, so
   * without one turn of the event loop every assertion below reads the charge
   * that is about to be given back.
   */
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const gastado = async () =>
    ((await passwordConfirmLimiter.getKey(CLAVE_RENOMBRE)) as { totalHits?: number } | undefined)
      ?.totalHits;

  /**
   * The account row with its password hash on it, which the shared fixture
   * deliberately leaves off.
   *
   * `beforeEach` builds the row `authenticate` asks for — two columns — and both
   * handlers here compare against `dataValues.pass`. Left as it is, every
   * comparison below would run against `undefined` while `bcryptjs.compare` is
   * mocked to say yes, which is the exact family of mistake this file exists to
   * catch.
   */
  const conHash = (extra: Record<string, unknown> = {}) => ({
    dataValues: {
      id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
      name: "Isaias", lastname: "Salas", image: null,
      failed_attempts: 0, locked_until: null, ...extra,
    },
  });

  /**
   * The same row, writable the way a Sequelize instance is.
   *
   * Needed only by the tests that assert a change actually went through. The
   * plain object above has no `set`, so a handler that reaches the write answers
   * 500 — which is why the two administrator tests below assert by exclusion
   * instead.
   */
  const escribible = (extra: Record<string, unknown> = {}) => {
    const row = conHash(extra);
    return {
      dataValues: row.dataValues,
      set: (patch: Record<string, unknown>) => Object.assign(row.dataValues, patch),
      save: async () => undefined,
      toJSON: () => ({ ...row.dataValues }),
    };
  };

  /**
   * A `bcryptjs.compare` that says yes to everything except one specific
   * plaintext — the "wrong" one a test is deliberately sending.
   *
   * Needed since the fix round that put `mfa_satisfied_at` back at its real,
   * shipped value (`null`): `requireStepUp`'s own password fallback and
   * `updateUserName`/`updateUserPass`'s own `oldPass` check both end up
   * calling this same globally mocked function, and several tests below need
   * the gate's `stepup_password` to succeed while a *different* string sent
   * as `oldPass` fails. A blanket `mockResolvedValue(false)` cannot express
   * that — it would fail the gate's own check too, and the request would
   * never reach the handler these tests are actually about.
   */
  const soloRechaza = (mala: string) => (plain: unknown) => Promise.resolve(plain !== mala);

  /** `stepup_password`'s value everywhere below it needs to be *correct*
   *  — anything other than whatever a given test names as the wrong one. */
  const STEP_UP_OK = "la-de-verdad";

  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE_RENOMBRE);
    await passwordConfirmLimiter.resetKey("pc:99");
    usuarioFindByPk.mockResolvedValue(conHash() as never);
  });

  it("charges the caller's account for a rename whose current password was wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    try {
      const res = await request(app)
        .put(`/api/usuario/username/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas", oldPass: "no-es-la-mia", stepup_password: STEP_UP_OK });
      await settled();

      // Not 404 — the route exists. Not 403 — `requireSelfOrPermission` let an
      // owner through. Not 500 — nothing in the chain threw.
      expect(res.status).toBe(401);
      // The sentence and not the number, imported rather than retyped: 401 is
      // also what `authenticate` answers, and a test reading the status alone
      // would pass for a route whose gate had been deleted and whose cookie had
      // simply stopped working.
      expect(res.body.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);

      // The point of this test. `pc:7` is the one key both routes count against,
      // so nobody gets ten attempts a quarter of an hour by alternating the two
      // doors onto one secret.
      expect(await gastado()).toBe(1);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("charges the caller's account for a password change whose current password was wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    usuarioFindOne.mockResolvedValue(conHash() as never);
    try {
      const res = await request(app)
        .put(`/api/usuario/userpass/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: "una-clave-de-prueba", oldPass: "no-es-la-mia", stepup_password: STEP_UP_OK });
      await settled();

      expect(res.status).toBe(401);
      expect(res.body.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      expect(await gastado()).toBe(1);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("counts the rename and the password change into one bucket, not one each", async () => {
    // The assertion a second `rateLimit()` call would break, and nothing else
    // would. Each `rateLimit()` builds a store of its own, so a per-route
    // limiter — even one keyed identically — would leave each of these reading
    // one hit, and anybody willing to alternate the two doors onto one secret
    // would get ten attempts a quarter of an hour instead of five.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    usuarioFindOne.mockResolvedValue(conHash() as never);
    try {
      for (const url of [`/api/usuario/username/${YO}`, `/api/usuario/userpass/${YO}`]) {
        const res = await request(app).put(url).set("Cookie", COOKIE).set(DEL_FRONTEND).send({
          user: "isalas",
          pass: "una-clave-de-prueba",
          oldPass: "no-es-la-mia",
          stepup_password: STEP_UP_OK,
        });
        await settled();
        // Both really reached the comparison, so the two hits below are two
        // wrong passwords and not two of anything else.
        expect(res.status, url).toBe(401);
      }

      expect(await gastado()).toBe(2);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("charges nothing for a request aimed at somebody else's account", async () => {
    /**
     * What provides this is `requiresOwnPassword`, and saying so is the whole
     * point of the rewrite.
     *
     * This test used to be called "charges nothing for a request the permission
     * guard already refused", and its comment credited the order of the mount:
     * *"the budget is mounted after the guard on purpose"*. It passed with the
     * two swapped — measured, 811 green — because the budget only charges when
     * the target is the caller and the guard only refuses when it is not. The
     * conditions are exactly complementary, so no response can tell the two
     * orders apart. The order is still deliberate and it is pinned structurally,
     * three tests below.
     *
     * `oldPass` is sent on purpose: a budget that keyed off the body carrying a
     * password rather than off whose account is being changed would charge here.
     */
    const res = await request(app)
      .put("/api/usuario/username/99")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas", oldPass: "la-mia" });
    await settled();

    expect(res.status).toBe(403);
    // Neither the caller's bucket nor the target's.
    expect(await gastado()).toBeUndefined();
    expect(await passwordConfirmLimiter.getKey("pc:99")).toBeUndefined();
  });

  it("charges nothing when an administrator renames somebody else", async () => {
    // The false positive this mount had to avoid. Renaming another account
    // sends no password and compares none, so billing it would answer 429 to
    // the sixth piece of legitimate administrative work in a quarter of an
    // hour. `can` is mocked false for the rest of this file; here the caller
    // holds the permission, so the guard passes on the permission and not on
    // ownership.
    //
    // What this is not about is `requireStepUp` itself — that gate reads
    // `stepup_password`, and this request targets somebody else's account, so
    // `requiresOwnPassword` (and therefore `chargeConfirmBudgetOnSelfChange`)
    // was never going to touch this bucket regardless. Giving *this* session a
    // satisfied window is what lets the request reach that question at all
    // without this test also having to carry a `stepup_password` field that
    // has nothing to do with what it is checking.
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION, id_usuario: YO, created_at: SESION_CREADA, expires_at: SESION_EXPIRA_FILA,
        last_used_at: new Date(), estado: "completa", mfa_satisfied_at: new Date(),
      },
    } as never);
    puede = true;
    try {
      const res = await request(app)
        .put("/api/usuario/username/99")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas" });
      await settled();

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(400);
      expect(await gastado()).toBeUndefined();
      // Nor did it land in anybody else's bucket, keyed by the target rather
      // than the caller.
      expect(await passwordConfirmLimiter.getKey("pc:99")).toBeUndefined();
    } finally {
      puede = false;
    }
  });

  it("charges nothing when an administrator resets somebody else's password", async () => {
    // The false positive to avoid, same as the rename above: resetting another
    // account sends no password and compares none, so billing it would answer
    // 429 to the sixth piece of legitimate administrative work in a quarter of
    // an hour.
    //
    // The status is asserted by exclusion rather than as a 200, for the reason
    // `escribible` above gives: `usuarioFindOne` here resolves a plain object
    // with no `set`, so the write itself cannot complete. What is under test is
    // the mount, and the mount runs before any of that.
    //
    // A satisfied window for the same reason as the rename test above: this
    // is about `requiresOwnPassword` sparing somebody else's account, not
    // about `requireStepUp`'s own fallback.
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION, id_usuario: YO, created_at: SESION_CREADA, expires_at: SESION_EXPIRA_FILA,
        last_used_at: new Date(), estado: "completa", mfa_satisfied_at: new Date(),
      },
    } as never);
    puede = true;
    try {
      const res = await request(app)
        .put("/api/usuario/userpass/99")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: "una-clave-de-prueba" });
      await settled();

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(400);
      expect(await gastado()).toBeUndefined();
      expect(await passwordConfirmLimiter.getKey("pc:99")).toBeUndefined();
    } finally {
      puede = false;
    }
  });

  it("mounts the permission guard before the budget on both routes", () => {
    /**
     * A structural assertion, and deliberately so — see the long note on
     * `chargeConfirmBudgetOnSelfChange` in `usuario.routes.ts`.
     *
     * The property is real and no response can show it: the guard refuses
     * exactly the requests the budget does not charge for, so both orders answer
     * identically to everything. Writing a request-shaped test for it is how the
     * test three above came to claim the order while `requiresOwnPassword` was
     * doing the work — the fifth assertion in this project to pass against the
     * code it said it protected. Reading the mounted chain says what is actually
     * being held.
     *
     * Worth holding because the day the charge condition widens, this order is
     * the only thing between a stranger and a stranger's allowance. The MFA
     * plan's step-up could easily want an administrator to send `oldPass` when
     * acting on somebody else — and then a budget in front of the guard is a
     * stranger emptying the target's bucket by being refused over and over.
     */
    type Capa = { route?: { path: string; stack: { name: string }[] } };
    const rutas = (usuarioRouter as unknown as { stack: Capa[] }).stack
      .filter((capa) => capa.route)
      .map((capa) => ({ path: capa.route.path, chain: capa.route.stack.map((h) => h.name) }));

    for (const path of ["/username/:id", "/userpass/:id"]) {
      const ruta = rutas.find((r) => r.path === path);
      expect(ruta, `${path} no está montada`).toBeDefined();
      const chain = ruta.chain;
      // Both present first. Without these two, the comparison below passes for a
      // chain missing either name, because `indexOf` answers -1 and -1 is less
      // than everything — which is precisely the shape of assertion this file's
      // header is about.
      expect(chain, path).toContain("requireSelfOrPermissionGate");
      expect(chain, path).toContain("chargeConfirmBudgetOnSelfChange");
      expect(
        chain.indexOf("requireSelfOrPermissionGate"),
        `${path}: ${chain.join(" -> ")}`,
      ).toBeLessThan(chain.indexOf("chargeConfirmBudgetOnSelfChange"));
    }
  });

  it("refunds the rename a cached frontend sends with no current password at all", async () => {
    /**
     * The deploy window this plan is most worried about, and it used to cost the
     * people caught in it their budget.
     *
     * A bundle sitting in somebody's tab from before this arc renames without an
     * `oldPass` field, because the field does not exist in it. Every one of those
     * requests is a 400 it cannot satisfy — and charging for them spent the
     * budget of exactly the people the transition hurts, then took the password
     * change down with it, on the same bucket, for a quarter of an hour.
     *
     * `stepup_password` is supplied so the request clears `requireStepUp`
     * first — a bundle old enough to be missing `oldPass` would also be
     * missing this field and get refused for *free* by the gate before ever
     * reaching the rename's own check, which is a real improvement over what
     * this test originally measured but not the thing it exists to prove.
     * What is under test here is unchanged: a legitimate, non-guessing 400
     * still gets refunded once it does reach `updateUserName`.
     */
    const res = await request(app)
      .put(`/api/usuario/username/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas", stepup_password: STEP_UP_OK });
    await settled();

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
    // Charged and given back. `0` and not `undefined`: the bucket was touched,
    // which is what proves the route is behind it and that the refund — not a
    // missing mount — is why nothing was spent.
    expect(await gastado()).toBe(0);
  });

  it("refunds a password change that only failed the new password's own policy", async () => {
    // The case the auditor bet the deploy on. Omar changes his own password,
    // types the current one correctly, and picks a new one of eight characters.
    // The server wants twelve. Nothing in that request is a guess: the
    // comparison already said yes, and the answer tells him so.
    usuarioFindOne.mockResolvedValue(conHash() as never);

    const res = await request(app)
      .put(`/api/usuario/userpass/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "ochochar", oldPass: "la-mia", stepup_password: STEP_UP_OK });
    await settled();

    expect(res.status).toBe(400);
    // The reason, so this cannot be the other 400 on this route — the one for a
    // missing current password, which is the test above.
    expect(res.body.message).toBe(DEMASIADO_CORTA);
    expect(await gastado()).toBe(0);
  });

  it("never runs out of budget on the password policy, however many times it refuses", async () => {
    /**
     * The premise `PASSWORD_CONFIRM_LIMIT` was calibrated on — "nobody
     * legitimately reaches five in a quarter of an hour" — restored to being
     * true.
     *
     * Reacting to "at least 12 characters" by adding one character at a time is
     * the normal thing for a person to do, and with a charge on every request
     * the sixth try answered "Demasiados intentos. Espere unos minutos" and
     * closed the rename too. Two past the limit here, so a charging bucket would
     * certainly have cut in.
     */
    usuarioFindOne.mockResolvedValue(conHash() as never);

    for (let i = 0; i < PASSWORD_CONFIRM_LIMIT + 2; i++) {
      const res = await request(app)
        .put(`/api/usuario/userpass/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: `corta${i}`, oldPass: "la-mia", stepup_password: STEP_UP_OK });
      await settled();

      // Still the policy talking, never the budget.
      expect(res.status, `intento ${i + 1}`).toBe(400);
      expect(res.body.message, `intento ${i + 1}`).toBe(DEMASIADO_CORTA);
    }

    expect(await gastado()).toBe(0);
  });

  it("runs out on wrong passwords, and then stops answering about the password at all", async () => {
    /**
     * The other side of the refund: the answers that do cost still add up, and
     * the limit still arrives.
     *
     * Somebody who has stolen a session cookie can ask these routes "is the
     * password X?" as often as they will answer, and a wrong answer costs the
     * account nothing by design — no `failed_attempts`, no lockout. So this
     * bucket is the whole of the limit, and it is keyed by account rather than
     * address so that asking from twenty addresses is still one budget.
     *
     * Runs with `mfa_satisfied_at: null` — the shared fixture's real value,
     * matching every session in production today, where nothing writes that
     * column yet. A fix-round review caught an earlier version of this test
     * describing a state that does not exist (the window pre-satisfied), which
     * made `requireStepUp` a no-op and left this arithmetic unwitnessed by
     * anything that actually runs. With the real state restored, each attempt
     * below pays into `pc:7` *twice* — once for `requireStepUp`'s own
     * fallback (the correct `stepup_password`, refunded), once for
     * `chargeConfirmBudgetOnSelfChange`'s own `oldPass` check (wrong, kept) —
     * and the arithmetic below still lands on exactly one net charge per
     * attempt, which is `confirmCostsNothing`'s consume-once mechanism doing
     * its job: see that function's comment in `loginLimiters.ts`.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("adivinando") as never);
    const attempt = () =>
      request(app)
        .put(`/api/usuario/username/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas", oldPass: "adivinando", stepup_password: STEP_UP_OK });
    try {
      for (let i = 0; i < PASSWORD_CONFIRM_LIMIT; i++) {
        const res = await attempt();
        await settled();
        expect(res.status, `intento ${i + 1}`).toBe(401);
        expect(res.body.message, `intento ${i + 1}`).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      }

      const cortado = await attempt();
      await settled();
      expect(cortado.status).toBe(429);
      // And the refusal is no longer readable as an answer about the password,
      // which is the property that makes a budget a budget rather than a slower
      // oracle.
      expect(cortado.body.message).not.toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      expect(cortado.body.message).toMatch(/Demasiados intentos/i);

      // And the 429 does not let the caller straight back in. It is refunded
      // too — it is not a 401 — so the counter falls back to the limit rather
      // than climbing past it; the next request has to cross it again, and does.
      const otro = await attempt();
      await settled();
      expect(otro.status).toBe(429);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("keeps one budget per account, not one for everybody", async () => {
    // A key generator that ignored `req.user` — or fell back to a constant —
    // would put the whole company in one bucket, and five wrong passwords by one
    // person would close the rename for everyone. The key is read out of the
    // bucket rather than inferred from a second caller's answer, because two
    // accounts cannot easily be signed in at once through this harness.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    try {
      await request(app)
        .put(`/api/usuario/username/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas", oldPass: "no-es-la-mia", stepup_password: STEP_UP_OK });
      await settled();

      expect(await gastado()).toBe(1);
      // Nothing landed in an address-shaped bucket, which is what the fallback
      // in `passwordConfirmKey` would have produced had `req.user` not been read.
      expect(await passwordConfirmLimiter.getKey("pc:ip:::ffff:127.0.0.1")).toBeUndefined();
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("lets a locked account rename itself with its own password, which is the ERP it is still working in", async () => {
    /**
     * F1, end to end through the real stack, and the reason it is here rather
     * than only beside `verifyOwnPassword`: the harm was never one function's
     * answer, it was the answer plus the token plus the shared bucket.
     *
     * Somebody who knows Ana's username fails five times on the login form and
     * her account rests for a quarter of an hour. `authenticate` does not read
     * `locked_until` — deliberately — so the session she already had keeps
     * working and she keeps using the ERP. She goes to rename herself and types
     * her password correctly; the shared comparator refused a resting account
     * before comparing anything, so she was told her password was wrong. Five
     * times, one token each, and the sixth answer was a 429 that also closed the
     * password change — the one screen that would have lifted the lockout.
     *
     * So: the rename goes through, and it costs her nothing.
     */
    usuarioFindByPk.mockResolvedValue(
      conHash({
        locked_until: new Date(Date.now() + 60_000),
        failed_attempts: LOCKOUT_AFTER_FAILURES,
      }) as never,
    );
    usuarioFindOne.mockResolvedValue(escribible() as never);

    const res = await request(app)
      .put(`/api/usuario/username/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas", oldPass: "la-mia", stepup_password: STEP_UP_OK });
    await settled();

    // The change itself, not merely "not a 401": a 500 or a 409 would satisfy
    // `not.toBe(401)` while leaving her exactly as stuck.
    expect(res.status).toBe(200);
    expect(res.body.user).toBe("isalas");
    expect(await gastado()).toBe(0);
  });
});

/**
 * `requireStepUp`, on the real routes it is mounted behind.
 *
 * `requireStepUp.test.ts` already proves the gate's own decisions against a
 * hand-built `req`/`res` — every branch, every refusal. What only a real
 * mount can show is the wiring around it: that the permission check truly
 * runs first (a caller without the permission spends no bcrypt comparison
 * and never queries the factor tables), that `PATCH /:id/desbloquear` really
 * has no gate on it, and that the real `factorInventory.js` module — not a
 * stub some other test replaced it with — is what decides whether the
 * password fallback is reachable at all.
 */
describe("requireStepUp, mounted on the real routes", () => {
  const CLAVE_YO = `pc:${YO}`;

  /** Puts the caller's own session back in the unsatisfied state this whole
   *  gate exists for — the shared default above satisfies its window. */
  function sinFactorReciente() {
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION, id_usuario: YO, created_at: SESION_CREADA, expires_at: SESION_EXPIRA_FILA,
        last_used_at: new Date(), estado: "completa", mfa_satisfied_at: null,
      },
    } as never);
  }

  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE_YO);
  });

  it("refuses without the permission before ever asking whether a factor exists", async () => {
    // `puede` stays false, the default for this whole file. If requireStepUp
    // ran first, a caller with no factor and no password would see its 403
    // and STEP_UP_REQUIRED instead of the permission's plain refusal — and
    // would have cost a query to the factor tables to get there.
    sinFactorReciente();
    const res = await request(app)
      .post("/api/usuario")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "nuevo" });

    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe(CODIGO_STEP_UP);
    expect(passkeyCount).not.toHaveBeenCalled();
    expect(totpCount).not.toHaveBeenCalled();
  });

  it("lets a user get created with no factor and no password, per the corrected rule: nothing to prove, so nothing is demanded", async () => {
    /**
     * A second audit found that the version of this gate this file first
     * pinned refused *every* gated write, unconditionally, the moment it
     * shipped: `web/src` never sends `stepup_password` (that frontend is a
     * later plan's job), so on a live account — no factor, unsatisfied
     * window — the fallback always read an absent field and always refused.
     * Saving the permission matrix, creating a role, an account changing its
     * own password: all of it, every account, always. This test is what
     * that outage looked like from the outside, now pinned the other way.
     */
    sinFactorReciente();
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo" });

      // Not a clean 200 — createUsuario needs more fields than this test
      // supplies. Pinned at the actual answer rather than merely excluding
      // 403: `usuarioFindOne`'s default fixture resolves *any* query to the
      // same row, so `nombreEnUso` reads that row back as "the name isn't
      // ours to keep" (`exceptoId` is `undefined` on a create, so the
      // exemption never applies) and answers 409 before createUsuario ever
      // reaches a write. Not 403, and not the 500 a missing-field crash
      // would also have passed under `not.toBe`, which is what actually
      // proves the gate let the request through rather than refusing it.
      expect(res.status).toBe(409);
      expect(res.status).not.toBe(403);
    } finally {
      puede = false;
    }
  });

  it("lets the same request through once the caller's own current password is supplied too", async () => {
    sinFactorReciente();
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo", stepup_password: "la-de-verdad" });

      // Same 409, same reason as the no-password test above — sending a
      // correct password on top changes nothing about what createUsuario
      // itself does with an incomplete body.
      expect(res.status).toBe(409);
    } finally {
      puede = false;
    }
  });

  it("still refuses a wrong password, even though the account has no factor to fall back on", async () => {
    // `bcryptjs.compare` defaults to "yes" for this whole file (every login
    // test sends a real-looking password and expects it accepted), so a
    // guess only reads as wrong here if the mock is told to say so for it
    // specifically.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(
      (async (plain: string) => plain !== "no-es-la-mia") as never,
    );
    sinFactorReciente();
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo", stepup_password: "no-es-la-mia" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
      // And it costs the real, shared budget — not the free skip a missing
      // password gets.
      expect(await passwordConfirmLimiter.getKey(CLAVE_YO)).toEqual(
        expect.objectContaining({ totalHits: 1 }),
      );
    } finally {
      puede = false;
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("refuses the password once the real factorInventory module reports one", async () => {
    // The real module, not a mock of it: this is what proves the mount reads
    // the genuine `tieneAlgunFactor`, not a stand-in some other file left
    // behind.
    sinFactorReciente();
    passkeyCount.mockResolvedValue(1);
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo", stepup_password: "la-de-verdad" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
    }
  });

  it("closes the skip on its own: the same no-password request that just succeeded is refused once a factor exists", async () => {
    // The assertion the corrected rule exists to make provable, not merely
    // arguable: nothing is flipped by hand between this test and the one
    // above it letting the identical body through. The only difference is
    // what the real `factorInventory` module reports.
    sinFactorReciente();
    passkeyCount.mockResolvedValue(1);
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
    }
  });

  it("does not gate PATCH /:id/desbloquear, on purpose", async () => {
    // Lifting a lockout is what an administrator does because somebody
    // cannot get in, often in a hurry — see the comment beside the route in
    // usuario.routes.ts. No stepup_password at all, and the account has no
    // factor and an unsatisfied window: if this route carried the gate, that
    // combination would answer 403 STEP_UP_REQUIRED before ever reaching the
    // permission check below it.
    sinFactorReciente();
    puede = true;
    try {
      const res = await request(app)
        .patch(`/api/usuario/${YO}/desbloquear`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({});

      // Pinned rather than merely excluding 403. `usuarioFindOne`'s default
      // fixture has no `.set`, so `desbloquearUsuario`'s own write throws and
      // the handler answers 500 — a fixture limit, not this route refusing
      // step-up. `not.toBe(403)` alone proves only "not exactly 403", which
      // stays green for a great many wrong reasons; the exact number is what
      // actually says the gate never ran.
      expect(res.status).toBe(500);
    } finally {
      puede = false;
    }
  });

  it("applies the same corrected rule to the permission matrix: no factor, no password, let through", async () => {
    // `/3` and not `/2`: `MI_ROL` is 2, and `putPermisos` refuses a caller
    // editing its own role (409) before it ever reads the body — a
    // collision this test does not want, since what it is proving is that
    // the gate let the request reach the handler at all.
    sinFactorReciente();
    puede = true;
    try {
      const res = await request(app)
        .put("/api/permisos/3")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({});

      // The gate let it through; `changesFrom({})` is what answers 400, for
      // its own reason ("No hay nada que guardar."), not step-up's.
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(403);
    } finally {
      puede = false;
    }
  });

  it("still gates the permission matrix against a wrong password", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(
      (async (plain: string) => plain !== "no-es-la-mia") as never,
    );
    sinFactorReciente();
    puede = true;
    try {
      const res = await request(app)
        .put("/api/permisos/3")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ stepup_password: "no-es-la-mia" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("survives confirming the same password twice in one request — this gate's own check, then the rename's own — without crashing or double-charging a right answer", async () => {
    /**
     * The trickiest shape this mount produces. With no factor registered and
     * an unsatisfied window, a self-rename on `/username/:id` confirms the
     * caller's password twice in the same request: once for this gate, once
     * for `updateUserName`'s own `oldPass` check — both against the very same
     * `pc:7` bucket, since both are `chargeConfirmBudgetOnSelfChange`'s
     * `passwordConfirmLimiter` and this gate's own call to it.
     * express-rate-limit's default `singleCount` validation assumes a key is
     * touched once per request; `passwordConfirmLimiter`'s `validate: {
     * singleCount: false }` (loginLimiters.ts) is what keeps that assumption
     * from doing anything worse than log once. Both confirmations are correct
     * here, so both are refunded and the budget ends the request where it
     * started.
     */
    sinFactorReciente();
    usuarioFindOne.mockResolvedValue({
      dataValues: {
        id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
        name: "Isaias", lastname: "Salas", image: null,
      },
      set(patch: Record<string, unknown>) {
        Object.assign(this.dataValues, patch);
      },
      save: async () => undefined,
      toJSON() {
        return { ...this.dataValues };
      },
    } as never);

    const res = await request(app)
      .put(`/api/usuario/username/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas-dos-veces", stepup_password: "la-de-verdad", oldPass: "la-de-verdad" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(await passwordConfirmLimiter.getKey(CLAVE_YO)).toEqual(
      expect.objectContaining({ totalHits: 0 }),
    );
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
describe("the addresses this arc retired", () => {
  it("has nothing at POST /api/auth/confirm-password, on a router that still serves five", async () => {
    /**
     * The endpoint that replaced "call the login and see if it works", retired
     * in turn because asking *before* an operation is the wrong shape: the
     * credential that authorises a write belongs in the request that performs
     * it, which is the rule the rename and the password change both follow. See
     * `auth.routes.ts`.
     *
     * A cookie is carried on purpose, for the reason the `permisos/mias` test
     * below spells out: `authenticate` is declared on every other route of this
     * router, so an anonymous request here could answer 401 whether the route
     * exists or not, and a 404 asserted without a credential would prove
     * nothing.
     */
    const res = await request(app)
      .post("/api/auth/confirm-password")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "una-clave-de-prueba" });
    expect(res.status).toBe(404);

    // The credential was good, so the 404 above cannot be read as a refusal.
    const me = await request(app).get("/api/auth/me").set("Cookie", COOKIE);
    expect(me.status).toBe(200);

    // And the router is still mounted. Without this the test would pass just as
    // well for somebody deleting `app.use("/api/auth", ...)` outright, which
    // would take the session cookie's own door down with it.
    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);
    expect(logout.status).toBe(200);
  });


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

/**
 * Task 4's two routes, through the real mount.
 *
 * Scope is deliberately narrower than the rest of this file: see the comment
 * on `usuarioUpdate`/`tokenUsoUnicoUpdate` above for why `/email/send`'s own
 * happy path — which opens a real `sequelize.transaction()` — is not
 * exercised here at all. What this section proves instead is the mounting
 * and the gating (both routes really sit behind `authenticate`, in the real
 * Express stack, not just in a hand-built `req`), the real body-parser's
 * shape per Global Constraint #13, and — for `/email/verify` specifically,
 * whose design never opens a transaction — a real round trip through the
 * real `tokenStore.js`.
 */
describe("email verification, through the real stack", () => {
  /**
   * `POST /email/send` now sits behind `passwordConfirmLimiter` too (Ronda
   * de arreglo 2) — the same shared `pc:7` bucket `usuario.routes.ts` mounts
   * on the rename and the password change, deliberately, since it is the
   * same secret being confirmed for the same account. That bucket is a
   * module-level store with no reset between describe blocks, and the tests
   * in "changing your own credentials..." above happen to leave it at 0 by
   * the time their block ends — but only because their own last test
   * confirms a *correct* password, which is refunded. That is incidental to
   * their ordering, not a guarantee this block should lean on, so it is
   * reset here explicitly.
   */
  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(`pc:${YO}`);
  });

  it("mounts both routes, and refuses both without a cookie", async () => {
    const send = await request(app).post("/api/auth/email/send").send({ email: "a@osefi.net" });
    const verify = await request(app).post("/api/auth/email/verify").send({ token: "x" });

    expect(send.status).toBe(401);
    expect(verify.status).toBe(401);
  });

  it("answers 400, not 500, for a POST with no body at all — Global Constraint #13", async () => {
    // With a cookie, so the 400 cannot be mistaken for the 401 the two tests
    // above already cover.
    const send = await request(app).post("/api/auth/email/send").set("Cookie", COOKIE).set(DEL_FRONTEND);
    const verify = await request(app).post("/api/auth/email/verify").set("Cookie", COOKIE).set(DEL_FRONTEND);

    expect(send.status).toBe(400);
    expect(verify.status).toBe(400);
    // Neither reached a write: the validation refused before either handler's
    // first database call.
    expect(usuarioUpdate).not.toHaveBeenCalled();
    expect(tokenUsoUnicoUpdate).not.toHaveBeenCalled();
  });

  it("gets past the email check and still refuses with no password, through the real mount", async () => {
    // Unlike the "no body at all" test above, `email` really is present and
    // valid here — this is a step deeper into the handler, past the point
    // that test exercises. What this pins is that `passwordConfirmLimiter`,
    // freshly mounted on this route, really calls `next()` for a fresh
    // account rather than answering 429 or 500 on its own, so the 400 seen
    // is the handler's own "no password sent" and not the limiter
    // misbehaving. A password-bearing happy path is still not exercised
    // here — see the comment on `usuarioUpdate`/`tokenUsoUnicoUpdate` above
    // for why `/email/send`'s own transaction keeps that out of this file's
    // scope.
    const res = await request(app)
      .post("/api/auth/email/send")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ email: "a@osefi.net" });

    expect(res.status).toBe(400);
    expect(usuarioUpdate).not.toHaveBeenCalled();
  });

  it("answers the generic message, through the real tokenStore, for a token that does not redeem", async () => {
    // `tokenUsoUnicoUpdate` defaults to `[0, []]` — no row matched, which is
    // exactly what a made-up token looks like against the real `consumirToken`.
    const res = await request(app)
      .post("/api/auth/email/verify")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ token: "un-token-inventado" });

    expect(res.status).toBe(400);
    expect(usuarioUpdate).not.toHaveBeenCalled();
  });

  it("verifies the token's own account for real, through the real tokenStore and the real model", async () => {
    // The one happy path in this section that is safe to run for real:
    // `verifyEmail` never opens a transaction (see `email.controller.ts`), so
    // `consumirToken`'s single `TokenUsoUnicoModel.update` — spied, not the
    // real query — is the only write this whole request makes before this
    // test's own `usuarioUpdate` spy takes the second one.
    tokenUsoUnicoUpdate.mockResolvedValue([
      1,
      [{ dataValues: { id_usuario: YO, email_destino: "isaias@osefi.net" } }],
    ] as never);
    usuarioFindByPk.mockResolvedValue({
      dataValues: { id: YO, email: "isaias@osefi.net" },
    } as never);

    const res = await request(app)
      .post("/api/auth/email/verify")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ token: "un-token-valido" });

    expect(res.status).toBe(200);
    const [values, options] = usuarioUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(values.email_verified_at).toBeInstanceOf(Date);
    expect(options.where).toEqual({ id: YO });
  });
});
