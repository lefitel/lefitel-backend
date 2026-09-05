// "Your own activity" — the twin of `evento.self.test.ts`, for the route that
// sentence was actually written about.
//
// `requireSelfOrPermission` takes the name of the route parameter as its
// **third argument, defaulting to `"id"`**. D1 moved this listing from
// `/api/bitacora/:id_usuario` to `/api/usuario/:id/bitacora`, so the default is
// now the correct one and the argument is gone. Carry the old `"id_usuario"`
// across, or name any parameter the route does not have, and the ownership
// branch compares `undefined` against the caller's id, never matches, and the
// gate degrades to permission-only. That is not a hypothetical: the middleware's own comment
// (`requirePermission.ts`) records that it shipped that way here once, and "a
// user may review their own activity" described a 403 for as long as the
// sentence existed.
//
// **Why nothing else catches it, measured rather than assumed.**
// `routeGuards.test.ts` reads the pair off the mounted chain and never sends a
// request, and says so about itself. `listShape.test.ts` mocks `can` to true
// for everything, so the permission branch answers first and the ownership
// branch is never reached. `bitacora.autores.test.ts` does the same. All three
// stay green with the third argument wrong. Only a request made *without* the
// permission can tell the two branches apart.
//
// **And the failure is silent at the other end.** `usePerfilData.ts` in `web`
// calls this with `.catch(() => [])`. A 403 here is an empty history on the
// profile screen, with nothing on screen and nothing in the console.
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
const { BitacoraModel } = await import("../models/bitacora.model.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const bitacoraFindAndCountAll = vi.spyOn(BitacoraModel, "findAndCountAll");

/** The caller. A coordinator: no `bitacora.ver`, which is the whole point. */
const YO = 7;
const OTRO = 8;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;

/** The one place the address is written. */
const direccion = (id: number | string) => `/api/usuario/${id}/bitacora`;

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
  bitacoraFindAndCountAll.mockResolvedValue({ rows: [], count: 0 } as never);
  sesionUpdate.mockRejectedValue(
    new Error("touchSession corrió: habría escrito en la base de datos") as never,
  );
});

const pedir = (id: number | string) => request(app).get(direccion(id)).set("Cookie", COOKIE);

/** The `where` the controller actually built, which is the half a status cannot see. */
const consultado = () =>
  (bitacoraFindAndCountAll.mock.calls[0]?.[0] as { where?: Record<string, unknown> })?.where;

describe("the activity of one person", () => {
  it("lets somebody read their own history without the permission", async () => {
    // 🔴 The assertion the third argument exists for. Named wrong, this answers
    // 403 — and the profile screen swallows it and prints an empty history.
    const res = await pedir(YO);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(bitacoraFindAndCountAll).toHaveBeenCalled();
    // And it asked about the right person. A gate that let the request through
    // against the wrong `where` would satisfy the status on its own — and this
    // is also the assertion that sees the controller reading the parameter by a
    // name the route no longer declares, which is a `where` of `undefined` and
    // a 500 rather than a 403.
    expect(consultado()).toEqual({ id_usuario: String(YO) });
  });

  it("refuses somebody else's history without the permission, before querying", async () => {
    const res = await pedir(OTRO);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/su propio usuario/i);
    expect(bitacoraFindAndCountAll, "consultó pese al rechazo").not.toHaveBeenCalled();
  });

  it("allows somebody else's history with bitacora.ver", async () => {
    // The other branch, without which "refuses everything" would pass the test
    // above and this file would be measuring a wall rather than a gate.
    puede = true;

    const res = await pedir(OTRO);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(consultado()).toEqual({ id_usuario: String(OTRO) });
  });

  it("refuses a session-less request before either branch", async () => {
    const res = await request(app).get(direccion(YO));

    expect(res.status).toBe(401);
    expect(bitacoraFindAndCountAll).not.toHaveBeenCalled();
  });

  it("does not treat a path that is not a number as anybody's own", async () => {
    // `Number("abc")` is `NaN`, and `NaN === 7` is false — so this is a 403 and
    // not a 500 from Postgres refusing to cast it, because the gate stops it
    // first.
    const res = await pedir("abc");

    expect(res.status).toBe(403);
    expect(bitacoraFindAndCountAll).not.toHaveBeenCalled();
  });
});
