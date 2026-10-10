// `GET /api/bitacora/authors`, through the real Express stack.
//
// Sibling of `opciones.test.ts` and built the same way. It was also the file
// that proved this literal was not swallowed by the `/:id_usuario` declared
// below it — and **D1 moved that sibling out of this router**, to
// `GET /api/usuario/:id/bitacora`. Two of the assertions here were about that
// race, and a literal cannot lose a race to a route that is not there: they
// would have stayed green for ever while measuring nothing. One was rewritten
// into the property that is still real — this endpoint reads accounts and must
// never read the log — and the other became the envelope check on `GET /`,
// which is the route of this router that still pages. The moved route's own
// gate is measured in `bitacora.self.test.ts`, and its envelope by the
// `LISTADOS` block of `listShape.test.ts`.
//
// `BitacoraModel.findAll` is still left rejecting. It is no longer a shadowing
// guard; it is the assertion that this endpoint never reaches for the log, on a
// machine whose configured database is a copy of production.
//
// **What is asserted off the spy, and what that is worth.** The model is not
// mocked — the rows in a response would be this file's own fixtures, so their
// keys would prove nothing — and the query the handler hands Sequelize is read
// instead. Three of those properties are echoes: `raw`, and the `paranoid` and
// `order` this file also writes down, mean only that the handler said what it
// said. Two are not:
//
//   - **the `where`**, which is the entire endpoint. Without it this is
//     `SELECT id, name, lastname FROM usuarios` — the staff directory, served
//     under `bitacora:ver`, to a role that was refused exactly that list at
//     `GET /api/usuario/`. The test reads the statement and checks it names the
//     author column of `bitacoras`, qualified.
//   - **the `attributes`**, checked against `USUARIO_AS_AUTHOR` itself rather
//     than against three strings. Nothing else in the repository guards this
//     one: `responseShape.test.ts` judges `UsuarioModel` only where it appears
//     inside an `include:`, and here it is the top-level model, so the file that
//     exists to stop user columns leaking does not look at this query at all.
//     Dropping the `attributes` line sends every column of `usuarios`, `pass`
//     among them, and leaves the whole suite green but this test.
//
// Nothing is asserted about the *contents* of a response here, and that is
// deliberate: the handler hands the rows it got straight to `res.json`, so any
// such assertion would be reading this file's own fixture back. The one thing
// the body can honestly settle is its shape — a list and not an envelope — and
// that is the single test that looks at it.
//
// Nothing here contacts Postgres, and in this environment that is not a nicety:
// the configured database is a copy of production. Every query the two routes
// touch is spied — `SesionModel.findOne`, the throttled `SesionModel.update`,
// `UsuarioModel.findByPk` from `authenticate`, and the two model calls of the
// controller itself — and the models are left real, because `vi.mock` on one of
// them breaks the association graph for every router `app.ts` loads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * What `can` answers. True by default — this is a gated read and most of the
 * file is about what it returns — and read through a variable so the refusal
 * test can flip it and put it back.
 */
let puede = true;
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => ({ bitacora: { ver: true } }),
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));

const app = (await import("../app.js")).default;
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel, USUARIO_AS_AUTHOR } = await import("../models/usuario.model.js");
const { BitacoraModel } = await import("../models/bitacora.model.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
/**
 * The third query `authenticate` can make, spied so that this file's claim —
 * nothing reaches Postgres — is asserted rather than assumed. `touchSession`
 * fires an UPDATE when the session's `last_used_at` is older than the throttle;
 * the fixture below stamps it now, so today it never fires. That is the throttle
 * constant doing the work, not this file, and lowering it would otherwise send a
 * real UPDATE to a copy of production with every test still green.
 */
const sesionUpdate = vi.spyOn(SesionModel, "update");

/** The endpoint's own query. */
const usuarioFindAll = vi.spyOn(UsuarioModel, "findAll");
/** `getAllBitacora`'s, read for the one assertion about the include. */
const bitacoraFindAndCountAll = vi.spyOn(BitacoraModel, "findAndCountAll");
/**
 * A tripwire, since C3: **no listing on this model uses `findAll` any more.**
 * Both bitácora handlers answer the standard envelope through `listar`, which
 * counts and fetches in one call. Left rejecting, so a handler that goes back
 * to `findAll` — and with it to a bare array — fails here rather than quietly
 * answering a different shape than the one this file pins.
 */
const bitacoraFindAll = vi.spyOn(BitacoraModel, "findAll");

const YO = 7;
const MI_ROL = 2;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
/**
 * A year back, and older than the session below: `authenticate` refuses a
 * session opened before the password last changed, so a recent value here would
 * turn every test in this file into a 401 about a password none of them touches.
 */
const PASS_CAMBIADA = new Date(Date.now() - 365 * 86_400_000);

/** Two live authors and one archived — the case the endpoint exists to keep. */
const AUTORES = [
  { id: 4, name: "Ana", lastname: "Quispe", deletedAt: null },
  { id: 9, name: "Bruno", lastname: "Mamani", deletedAt: new Date("2026-05-02") },
  { id: 12, name: "Carla", lastname: "Vargas", deletedAt: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  puede = true;
  sesionFindOne.mockResolvedValue({
    dataValues: {
      id: "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa",
      id_usuario: YO,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
      last_used_at: new Date(),
      estado: "completa",
      mfa_satisfied_at: null,
      mfa_source: null,
    },
  } as never);
  usuarioFindByPk.mockResolvedValue({
    dataValues: {
      id: YO, id_rol: MI_ROL, user: "isaias", name: "Isaias", lastname: "Salas",
      image: null, pass_changed_at: PASS_CAMBIADA,
    },
  } as never);

  usuarioFindAll.mockResolvedValue(AUTORES as never);
  bitacoraFindAndCountAll.mockResolvedValue({ count: 0, rows: [] } as never);
  bitacoraFindAll.mockRejectedValue(
    new Error("el listador de la bitácora corrió: /authors leyó el log") as never,
  );
  sesionUpdate.mockRejectedValue(
    new Error("touchSession corrió: este test habría escrito en la base de datos") as never,
  );
});

/** What the handler asked Sequelize for, on the first call of that spy. */
const consulta = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls[0]?.[0] as
    | {
        attributes?: unknown;
        where?: unknown;
        order?: unknown;
        raw?: unknown;
        paranoid?: unknown;
        include?: { paranoid?: unknown; attributes?: unknown }[];
      }
    | undefined;

/** The SQL a Sequelize `literal` carries, whatever wrapper it arrives in. */
const sqlDe = (where: unknown) => String((where as { val?: unknown } | undefined)?.val ?? "");

describe("the route is reachable at all", () => {
  it("answers /api/bitacora/authors by reading accounts and never the log", async () => {
    const res = await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    // Not a shadowing check any more — D1 moved the parametric sibling to
    // `/api/usuario/:id/bitacora`, so there is nothing left in this router that
    // could swallow the literal. What it still measures is real and is what the
    // endpoint is for: the author list is built from accounts that have entries,
    // read off `UsuarioModel`, and reading the log itself would be both slower
    // and a different answer. `bitacoraFindAll` rejects, so a handler that
    // reached for it fails here rather than querying a copy of production.
    expect(bitacoraFindAndCountAll, "/authors leyó la bitácora en vez de las cuentas")
      .not.toHaveBeenCalled();
  });

  it("leaves the full log at GET / answering the envelope", async () => {
    // The other route of this router, and the reason `/authors` being a literal
    // still matters: both are declared on the same mount and a future
    // `/authors/:algo` would put them back in a race. It also pins the envelope
    // C3 gave this listing, which it did not have.
    bitacoraFindAndCountAll.mockResolvedValue({ count: 1, rows: [{ toJSON: () => ({ id: 1, action: "login", entity: "Usuario" }) }] } as never);

    const res = await request(app).get("/api/bitacora/").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(bitacoraFindAndCountAll).toHaveBeenCalled();
    expect(Object.keys(res.body).sort()).toEqual(["data", "limit", "page", "total"]);
  });
});

describe("what it asks the database for", () => {
  it("asks only for accounts that have entries", async () => {
    await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    // The whole endpoint, in one property. Without a `where` this is the staff
    // directory — every account, including the ones that never touched the
    // system — served under `bitacora:ver` to a role that `GET /api/usuario/`
    // refuses. Read as SQL text because that is what a `literal` is.
    const sql = sqlDe(consulta(usuarioFindAll)?.where);
    expect(sql).toContain("EXISTS");
    // Qualified on both sides, and this is not style: `bitacoras` has an `id`
    // column of its own, so an unqualified reference is ambiguous and Postgres
    // refuses the statement outright — a 500 on every load of the screen.
    expect(sql).toContain('"bitacoras"."id_usuario" = "usuario"."id"');
  });

  it("asks for the author columns and nothing else", async () => {
    await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    // Against the constant, not against three strings: what this pins is that
    // the projection is the shared author shape plus the one column this screen
    // needs, so that widening `USUARIO_AS_AUTHOR` elsewhere cannot silently
    // widen this response, and dropping the line cannot ship `pass`.
    expect(consulta(usuarioFindAll)?.attributes).toEqual([...USUARIO_AS_AUTHOR, "deletedAt"]);
  });

  it("includes archived accounts, which is the half a plain query would lose", async () => {
    await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    // `UsuarioModel` is paranoid, so the default query hides exactly the people
    // whose entries somebody is most likely to be looking for: the ones who have
    // left. Two properties, one intent — select them, and carry the column that
    // lets the screen say so.
    expect(consulta(usuarioFindAll)?.paranoid).toBe(false);
    expect(consulta(usuarioFindAll)?.attributes).toContain("deletedAt");
  });

  it("orders the list for a person reading it", async () => {
    await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    // Alphabetical, and deliberately not the `id DESC` of the catalogue
    // endpoints: that order exists so an export's columns stay put between runs,
    // and this list is a dropdown somebody scans for a name. Unordered, it
    // arrives in Postgres's heap order, which moves after an UPDATE or a VACUUM.
    expect(consulta(usuarioFindAll)?.order).toEqual([["name", "ASC"], ["lastname", "ASC"]]);
  });
});

describe("what it answers with", () => {
  it("answers a bare list, not an envelope", async () => {
    const res = await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    // §3.3: the envelope is for paginated collections. This is a block of
    // id/name pairs, like the three `/options` responses, and the client reads
    // it straight into a dropdown.
    expect(Array.isArray(res.body), `contestó ${JSON.stringify(res.body).slice(0, 80)}`).toBe(true);
    expect(res.body).toHaveLength(AUTORES.length);
  });
});

describe("the entries themselves keep their author", () => {
  it("reads the log with archived authors joined in", async () => {
    await request(app).get("/api/bitacora/").set("Cookie", COOKIE);

    // `paranoid: false` belongs to the include and not to the query: Sequelize
    // recurses into each include with the include itself as its options, so the
    // outer value does not reach it. Set outside, the join keeps its
    // `deletedAt IS NULL` condition and every entry written by an archived
    // account arrives with `usuario: null` — the screen then prints `#12`, and
    // `BitacoraPanel` prints no author at all.
    expect(consulta(bitacoraFindAndCountAll)?.include?.[0]?.paranoid).toBe(false);
  });
});

describe("who may call it", () => {
  it("refuses an account without the permission", async () => {
    puede = false;

    const res = await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);

    expect(res.status).toBe(403);
    // And it refused before asking: a 403 that still ran the query would have
    // read the directory for somebody who may not see it.
    expect(usuarioFindAll).not.toHaveBeenCalled();
  });

  it("refuses a request with no session at all", async () => {
    const res = await request(app).get("/api/bitacora/authors");

    expect(res.status).toBe(401);
  });

  it("reached the database on the happy path, so the tests above are not vacuous", async () => {
    // Every assertion here reads a spy, and a spy never called answers
    // `undefined` — which several of the expectations above would accept if one
    // were ever loosened. This is the guard the four source-level tests in
    // `src/controllers/` all carry, in the form this file needs it.
    await request(app).get("/api/bitacora/authors").set("Cookie", COOKIE);
    await request(app).get("/api/bitacora/").set("Cookie", COOKIE);

    expect(usuarioFindAll).toHaveBeenCalled();
    expect(bitacoraFindAndCountAll).toHaveBeenCalled();
    // And the one write on the request path never ran. If this ever fails, the
    // session touch reached past its throttle — and, unspied, it would have
    // written to a copy of production.
    expect(sesionUpdate, "touchSession intentó escribir la sesión").not.toHaveBeenCalled();
  });
});
