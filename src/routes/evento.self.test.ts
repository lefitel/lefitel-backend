// "Your own history" — the one gate of C5 that no other test in this repository
// can measure, and the one whose failure is silent.
//
// `GET /api/usuario/:id/eventos` answered any session until C5, at the address
// `/api/evento/usuario/:id_usuario` it had until D1. It asks about a *person*,
// not about the work, so the pair is `seguridad.ver` and not `eventos.ver`: the
// Cliente role holds `eventos.ver`, and with the obvious gate it could walk
// `/usuario/1` … `/usuario/20` and assemble each employee's activity record.
// But it is also what the profile screen calls for the person looking at it, so
// a plain gate would take every non-administrator's own history away.
//
// Hence `requireSelfOrPermission`, and hence this file. That middleware takes
// the name of the route parameter as its **third argument, defaulting to
// `"id"`**. D1 renamed this route's parameter to `:id`, so the default is now
// the correct one and the argument is gone — carry the old `"id_usuario"`
// across with the line and the ownership branch compares `undefined` against
// the caller's id, never matches, and the gate quietly degrades to
// permission-only. It is not a hypothetical: the middleware's own comment
// records that this shipped once on the bitácora route, where "a user may
// review their own activity" described a 403 for as long as the sentence
// existed. `bitacora.self.test.ts` is the twin of this file for that route.
//
// **Why nothing else catches it.** `routeGuards.test.ts` reads the pair off the
// mounted chain and never sends a request, so the argument is invisible to it.
// `listShape.test.ts` mocks `can` to true for everything, so the permission
// branch answers first and the ownership branch is never reached. Both stay
// green with the argument gone. Only a request made *without* the permission
// can tell the two branches apart, which is what this file does.
//
// Models are spied and not mocked: `vi.mock` on a model breaks the association
// graph for every router `app.ts` loads. Nothing here reaches Postgres, and in
// this environment that is not a nicety — the configured database is a copy of
// production.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/** Flipped per test. False is the interesting half: it is where ownership decides. */
let puede = false;
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => ({}),
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));

const app = (await import("../app.js")).default;
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { EventoModel } = await import("../models/evento.model.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const eventoFindAndCountAll = vi.spyOn(EventoModel, "findAndCountAll");

/** The caller. A coordinator: no `seguridad.ver`, which is the whole point. */
const YO = 7;
const OTRO = 8;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;

beforeEach(() => {
  vi.clearAllMocks();
  puede = false;
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
      id: YO, id_rol: 2, user: "isaias", name: "Isaias", lastname: "Salas",
      image: null, pass_changed_at: new Date(Date.now() - 365 * 86_400_000),
    },
  } as never);
  eventoFindAndCountAll.mockResolvedValue({ rows: [], count: 0 } as never);
  sesionUpdate.mockRejectedValue(
    new Error("touchSession corrió: habría escrito en la base de datos") as never,
  );
});

/** The one place the address is written. */
const direccion = (id: number | string) => `/api/usuario/${id}/eventos`;

const pedir = (id: number | string) => request(app).get(direccion(id)).set("Cookie", COOKIE);

describe("the incidents of one person", () => {
  it("lets somebody read their own history without the permission", async () => {
    // 🔴 The assertion the third argument exists for. With the default `"id"`
    // this answers 403, and the profile screen — which swallows the failure and
    // prints "Eventos atendidos: 0" — would never say so.
    const res = await pedir(YO);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(eventoFindAndCountAll).toHaveBeenCalled();
    // And it asked about the right person, rather than answering with anybody's
    // rows: a gate that let the request through against the wrong `where` would
    // satisfy the status alone.
    const where = (eventoFindAndCountAll.mock.calls[0]?.[0] as { where?: Record<string, unknown> })?.where;
    expect(where).toEqual({ id_usuario: String(YO) });
  });

  it("refuses somebody else's history without the permission, before querying", async () => {
    const res = await pedir(OTRO);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/su propio usuario/i);
    expect(eventoFindAndCountAll, "consultó pese al rechazo").not.toHaveBeenCalled();
  });

  it("allows somebody else's history with seguridad.ver", async () => {
    // The other branch, without which "refuses everything" would pass the test
    // above and this file would be measuring a wall rather than a gate.
    puede = true;

    const res = await pedir(OTRO);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const where = (eventoFindAndCountAll.mock.calls[0]?.[0] as { where?: Record<string, unknown> })?.where;
    expect(where).toEqual({ id_usuario: String(OTRO) });
  });

  it("refuses a session-less request before either branch", async () => {
    const res = await request(app).get(direccion(YO));

    expect(res.status).toBe(401);
    expect(eventoFindAndCountAll).not.toHaveBeenCalled();
  });

  it("does not treat a path that is not a number as anybody's own", async () => {
    // `Number("abc")` is `NaN`, and `NaN === 7` is false — so this is a 403 and
    // not the neutral 500 the controller used to answer, because the gate now
    // stops it before Postgres is asked to cast it.
    const res = await pedir("abc");

    expect(res.status).toBe(403);
    expect(eventoFindAndCountAll).not.toHaveBeenCalled();
  });
});
