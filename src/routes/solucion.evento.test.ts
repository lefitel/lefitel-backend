// The repair of one incident — the one route in this API whose breakage is
// completely silent, and until this file the only one of the seven that D1
// moves that no test ever *requested*.
//
// Two properties are load-bearing here and neither is visible from a route
// table:
//
// 1. **It answers the object or `null`, unwrapped.** §3.3 of the API standard
//    keeps the envelope for paginated collections and makes this an explicit
//    exception: `{data: null}` is truthy, so wrapping it would paint every
//    unresolved incident as resolved. `null` *is* the normal answer — most
//    incidents are open.
// 2. **Both callers in `web` swallow the failure.** `useEventoDetalleData.ts`
//    and `EventoSheet.tsx` both call it as `.catch(() => null)`, which is
//    indistinguishable from "not resolved". So a 403, a 404 or a 500 here shows
//    up as every repaired incident reading as pending, with nothing on screen
//    and nothing in the console.
//
// `listShape.test.ts` lists this address but files it under `AGREGADAS`, a
// group it never sends a request to — it only checks the address is declared.
// `routeGuards.test.ts` reads the permission pair off the mounted chain without
// making a request. Neither can see the parameter name, the `where`, the status
// or the body.
//
// D1 moved this here from `GET /api/solucion/evento/:id_evento` and renamed the
// route parameter to `:id`. That is exactly the change these assertions exist
// to survive, and they were written and seen green against the old address
// first, so that the move had something to fail.
//
// Models are spied and not mocked: `vi.mock` on a model breaks the association
// graph for every router `app.ts` loads. Nothing here reaches Postgres, and in
// this environment that is not a nicety — the configured database is a copy of
// production.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

let puede = true;
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => ({}),
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));

const app = (await import("../app.js")).default;
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { SolucionModel, SOLUCION_PUBLIC_ATTRIBUTES } = await import("../models/solucion.model.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const solucionFindOne = vi.spyOn(SolucionModel, "findOne");

const YO = 7;
const EVENTO = 5;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;

/** The one place the address is written. */
const direccion = (id: number | string) => `/api/evento/${id}/solucion`;

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
      id: YO, id_rol: 2, user: "isaias", name: "Isaias", lastname: "Salas",
      image: null, pass_changed_at: new Date(Date.now() - 365 * 86_400_000),
    },
  } as never);
  solucionFindOne.mockResolvedValue(null as never);
  sesionUpdate.mockRejectedValue(
    new Error("touchSession corrió: habría escrito en la base de datos") as never,
  );
});

const pedir = (id: number | string) => request(app).get(direccion(id)).set("Cookie", COOKIE);

/** The options the controller actually built — the half a status cannot see. */
const consulta = () =>
  solucionFindOne.mock.calls[0]?.[0] as
    | { where?: Record<string, unknown>; attributes?: readonly string[] }
    | undefined;

describe("the repair of one incident", () => {
  it("asks for the incident in the path", async () => {
    // 🔴 The assertion that survives the move to `/api/evento/:id/solucion`.
    // Read the parameter by a name the route no longer declares and this `where`
    // becomes `{id_evento: undefined}` — which Postgres refuses, so the browser
    // gets a 500 that both callers turn into "not resolved yet".
    const res = await pedir(EVENTO);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(consulta()?.where).toEqual({ id_evento: String(EVENTO) });
  });

  it("answers a bare null when the incident is not resolved, and not an envelope", async () => {
    // The normal case, and the one that has to stay unwrapped: `{data: null}`
    // is truthy, so an envelope here would mark every open incident as fixed.
    const res = await pedir(EVENTO);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    // On the wire, and not merely after parsing: `{"data":null}` also parses to
    // something falsy in a careless assertion, and this is the one route where
    // that distinction decides whether an open incident reads as fixed.
    expect(res.text).toBe("null");
  });

  it("answers the repair itself when there is one", async () => {
    solucionFindOne.mockResolvedValue({
      id: 3, description: "Se cambió el herraje", image: null,
      date: "2026-09-01", id_evento: EVENTO,
    } as never);

    const res = await pedir(EVENTO);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 3, id_evento: EVENTO });
  });

  it("never carries who carried out the repair", async () => {
    // The author is provenance, not content. It is left out at the query, so it
    // cannot leak through a model change either.
    await pedir(EVENTO);

    expect(consulta()?.attributes).toEqual([...SOLUCION_PUBLIC_ATTRIBUTES]);
    expect(consulta()?.attributes).not.toContain("id_usuario");
  });

  it("refuses a caller without eventos.ver, before querying", async () => {
    // C5 gave this route a gate. The comment in the controller still said it had
    // none until D1; the assertion is here so the sentence cannot drift again.
    puede = false;

    const res = await pedir(EVENTO);

    expect(res.status).toBe(403);
    expect(solucionFindOne, "consultó pese al rechazo").not.toHaveBeenCalled();
  });

  it("refuses a session-less request", async () => {
    const res = await request(app).get(direccion(EVENTO));

    expect(res.status).toBe(401);
    expect(solucionFindOne).not.toHaveBeenCalled();
  });
});
