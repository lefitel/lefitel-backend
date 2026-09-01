// The field photographs, and the fact that a file name used to be the whole
// credential.
//
// `express.static(IMAGES_DIR)` was mounted above every `/api/...` router and
// eleven lines above the first `authenticate`, so `GET /1712428860328_210.jpg`
// answered 200 with the image to anybody on the internet. The names are not a
// secret: `upload.controller.ts` writes `${Date.now()}_${originalName}`, and
// the original names in this database are `Imagen1`..`Imagen26`, WhatsApp
// names carrying their own date, and in some rows the pole number itself.
//
// This file exists because the fix is *positional* — the mount has to stay
// below the API routers and behind a session gate — and position is exactly
// what a reorder undoes without any test noticing. `routeGuards.test.ts`
// cannot cover it: its walker reads route-level handler names off
// `app._router.stack`, and a path-less `app.use` lands in its `beforeRouter`
// bucket alongside `helmet` and `cors`, where nothing asserts on it. That is
// why the hole survived every guard test this repo has — twice: first as "no
// session required at all", then, once `authenticate` grew a session-state
// gate for a later plan, as "every `onboarding` session gets 403 on every
// photograph". See the last `describe` below for that second one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { EstadoSesion } from "./auth/sessionState.js";

/**
 * Only the two calls this file's requests can actually reach are replaced.
 *
 * `findLiveSession` and `touchSession` are the ones that hit Postgres —
 * `SesionModel.findOne` / `.update` inside `auth/sessionStore.ts` — and this
 * suite runs against `osefi_local` (see `.env`), a copy of production with
 * real accounts in it. Everything else that module exports comes back through
 * `importOriginal` untouched: `slidingExpiry` and `cappedByCeiling` are pure
 * arithmetic, and none of the requests below reach `createSession` or the
 * revoke/list functions at all.
 *
 * A full `vi.mock` with no `importOriginal` would work for this module
 * specifically — unlike `usuario.model.js` below, `sessionStore.ts` declares
 * no Sequelize associations for anything to break — but keeping the untouched
 * exports real is one line cheaper than re-declaring five functions this file
 * never calls.
 */
const findLiveSession = vi.fn();
const touchSession = vi.fn();
vi.mock("./auth/sessionStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth/sessionStore.js")>();
  return {
    ...actual,
    findLiveSession: (...a: unknown[]) => findLiveSession(...a),
    touchSession: (...a: unknown[]) => touchSession(...a),
  };
});

const app = (await import("./app.js")).default;
const { SESSION_COOKIE_NAME } = await import("./auth/sessionCookie.js");
const { UsuarioModel } = await import("./models/usuario.model.js");

/**
 * The role and the two extra columns `currentUser` (`middleware/authenticate.ts`)
 * reads, spied rather than mocked wholesale.
 *
 * `app.js` imports every router, and several other model files call
 * `UsuarioModel.hasMany(...)` / `belongsTo(UsuarioModel, ...)` while they load —
 * a full `vi.mock` of this module would hand Sequelize something that is not a
 * model subclass and break every one of those associations at import time, for
 * every test in this file, not only the ones about images. `vi.spyOn` swaps
 * only the one method actually called, on the real class. See `app.auth.test.ts`
 * for the same trap, hit first.
 */
const findByPk = vi.spyOn(UsuarioModel, "findByPk");

beforeEach(() => {
  vi.clearAllMocks();
  // No live session by default, unless a test below says otherwise. This is
  // what a syntactically valid but nonexistent cookie really gets back from
  // `sesiones`, and fixing it here is what makes the two tests below
  // deterministic instead of depending on whichever database this process
  // happens to be configured against.
  findLiveSession.mockResolvedValue(null);
});

describe("stored images are behind the session", () => {
  it("refuses a photograph to a caller with no cookie", async () => {
    // The shape of a real stored name, from the database: a millisecond stamp
    // and the camera's own file name.
    const res = await request(app).get("/1712428860328_210.jpg");

    expect(res.status).toBe(401);
  });

  it("never hands the file to a cookie that is not a live session", async () => {
    // `findLiveSession` is mocked to `null` above — the real answer `sesiones`
    // gives for a token nobody ever issued. What must hold is that the bytes
    // never leave: the old mount answered 200 here, with no cookie at all.
    const res = await request(app)
      .get("/1712428860328_210.jpg")
      .set("Cookie", `${SESSION_COOKIE_NAME}=no-es-una-sesion`);

    expect(res.status).toBe(401);
  });

  it("answers the same 401 whether or not the file exists", async () => {
    // The session gate runs before `express.static` gets to look at the disk,
    // so a missing name and a real one are indistinguishable from outside.
    // That is not incidental: the old mount answered 200 for a hit and a clean
    // 404 for a miss, which made the endpoint an oracle for guessing names —
    // and the only unguessable part of a name is a millisecond.
    const conNombreReal = await request(app).get("/1712428860328_210.jpg");
    const conNombreInventado = await request(app).get("/no-existe-este-fichero-jamas.jpg");

    expect(conNombreReal.status).toBe(401);
    expect(conNombreInventado.status).toBe(401);
  });
});

describe("what the images mount must not have broken", () => {
  it("leaves an unknown /api path a 404, not a 401", async () => {
    // The guard skips `/api/...` on purpose. Without it this mount would answer
    // every client typo with "su sesión expiró", which reads as a session bug
    // and sends whoever hit it to log in again.
    const res = await request(app).get("/api/no-existe");

    expect(res.status).toBe(404);
  });

  it("still lets an unauthenticated caller reach the login route", async () => {
    // The reason the mount had to move below the routers instead of being
    // wrapped where it stood: a path-less `app.use(authenticate, ...)` runs for
    // everything underneath it, and `POST /api/login` is the one route that
    // cannot be asked for a session because it is what issues one.
    const res = await request(app).post("/api/login").send({});

    expect(res.status).not.toBe(401);
  });
});

describe("what each session state may reach among the images — the regression this task closes", () => {
  // Until `authenticateArchivos` existed (`middleware/authenticate.ts`), this
  // mount ran behind plain `authenticate`, whose only allowlist —
  // `puedeAlcanzar`, `auth/sessionState.ts` — is written for `/api/...` and has
  // no opinion about a path outside it. Asked anyway, it answered `false` for
  // every state but `completa`, because nothing in it was ever meant to
  // describe this route. So the day an account's `mfa_grace_until` went by,
  // `onboarding` got **403 on every photograph in the ERP** — the header
  // avatar and every field image — not because onboarding was meant to lose
  // images but because nobody had ever decided the question for this mount.
  // `completa` never showed it, since `puedeAlcanzar("completa", ...)` is
  // unconditionally `"todo"`, which is why the hole was invisible until a
  // grace period actually expired.
  //
  // None of these three cases existed here before: `routeGuards.test.ts`
  // cannot see a path-less `app.use` at all (see the top of this file), and
  // nothing above this block ever sent a *live* session through the mount,
  // partial or otherwise.

  const CREADA = new Date(Date.now() - 60_000);

  /** A live session row shaped like `findLiveSession`'s real return. */
  const sesionCon = (estado: EstadoSesion) => ({
    id: "s1",
    id_usuario: 7,
    created_at: CREADA,
    expires_at: new Date(Date.now() + 1e6),
    last_used_at: new Date(),
    estado,
    mfa_satisfied_at: null,
    mfa_source: null,
  });

  beforeEach(() => {
    // `mfa_grace_until: null` on purpose: this block is about what each
    // *stored* state may reach, not about `estadoEfectivo` narrowing a
    // `completa` row — that recomputation is `authenticate.test.ts`'s and
    // `sessionState.test.ts`'s job, against the real function directly. `null`
    // leaves every stored state exactly as given.
    findByPk.mockResolvedValue({
      dataValues: { id: 7, id_rol: 2, pass_changed_at: new Date(0), mfa_grace_until: null },
    } as never);
  });

  it("closes the photograph to a partial session, unchanged: half a login sees nothing", async () => {
    // The one state this task deliberately leaves alone. A password with no
    // factor proved yet has no business rendering anything belonging to an
    // application it has not entered — see `puedeVerArchivosEstaticos`'s own
    // comment in `auth/sessionState.ts` for why.
    findLiveSession.mockResolvedValue(sesionCon("parcial") as never);
    const res = await request(app)
      .get("/1712428860328_210.jpg")
      .set("Cookie", `${SESSION_COOKIE_NAME}=t`);

    expect(res.status).toBe(401);
  });

  it("opens the photograph to an onboarding session — the 403 this task exists to close", async () => {
    // The finding, reproduced directly: before `authenticateArchivos`, this
    // request answered 403 with `MENSAJE_FACTOR_PENDIENTE`. Now it must reach
    // `express.static` and be judged on the file's own terms — 404, since this
    // name is fictitious and answers the same way the no-cookie test above
    // pins it should for a *missing* file once a request is actually let
    // through.
    findLiveSession.mockResolvedValue(sesionCon("onboarding") as never);
    const res = await request(app)
      .get("/1712428860328_210.jpg")
      .set("Cookie", `${SESSION_COOKIE_NAME}=t`);

    expect(res.status).toBe(404);
  });

  it("keeps the photograph open to a complete session, unchanged", async () => {
    // The state this mount always worked for — pinned so a refactor of
    // `puedeVerArchivosEstaticos` cannot narrow it by accident the way the
    // defect narrowed `onboarding`.
    findLiveSession.mockResolvedValue(sesionCon("completa") as never);
    const res = await request(app)
      .get("/1712428860328_210.jpg")
      .set("Cookie", `${SESSION_COOKIE_NAME}=t`);

    expect(res.status).toBe(404);
  });
});
