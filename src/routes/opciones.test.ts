// The three options endpoints, through the real Express stack.
//
// Sibling of `routeOrder.test.ts`, and the division between them matters.
// That one asserts the *rule* — no route may be shadowed by an earlier one —
// over every router in the API, generically, off the compiled layer list. This
// one goes in through `supertest` and proves the three new endpoints behave: the
// blocks they answer with, the exact columns they ask the database for, and the
// one fact no route table can establish.
//
// **The fact only a request can establish.** The layer list says
// `GET /api/poste/options` exists and sits before `/:id`. It cannot say which
// layer Express's matcher picks, because Express 5 compiles a path into closures
// over a pattern nothing exposes — `routeGuards.test.ts`'s header comment is
// about exactly that. So the proof here is not the 200: it is that
// `PosteModel.findOne`, the query `searchPoste` makes, was **never called**. A
// response of the right shape could in principle come from anywhere; `findOne`
// never being reached is what "the literal won" means.
//
// **Why the columns are asserted off the spy and not off the response.** Every
// model query in this file is mocked, so the rows in the response are the rows
// this test invented — asserting their keys would assert the mock. What decides
// the columns for real is the `attributes` the handler hands Sequelize, and that
// is readable here, call by call. The one place the response body is asserted on
// its own merits is `tramos`, which is computed in our code rather than selected
// by the database.
//
// Nothing here contacts Postgres, and in this environment that is not a
// nicety: the configured database is a copy of production. Every query method
// these three handlers touch is spied, the models themselves are left real —
// five of the ten model modules imported here declare associations while being
// imported, and `vi.mock` on one of those breaks the graph for every router
// `app.ts` loads — and none of the handlers opens a transaction.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const permisos = { postes: { ver: true } };
/**
 * What `can` answers. True for everything by default — these are three gated
 * reads and the point of most tests here is what they return — and read through
 * a variable so the refusal test can flip it and put it back.
 */
let puede = true;
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => permisos,
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));

const app = (await import("../app.js")).default;
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { AdssModel } = await import("../models/adss.model.js");
const { CiudadModel } = await import("../models/ciudad.model.js");
const { MaterialModel } = await import("../models/material.model.js");
const { ObsModel } = await import("../models/obs.model.js");
const { PosteModel } = await import("../models/poste.model.js");
const { PropietarioModel } = await import("../models/propietario.model.js");
const { TipoObsModel } = await import("../models/tipoObs.model.js");
const { TramoModel } = await import("../models/tramo.model.js");
const { DepartamentoModel } = await import("../models/departamento.model.js");
const { EventoModel } = await import("../models/evento.model.js");
const { INCLUDE_TRAMO } = await import("../tramos/presentacion.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
/**
 * The third query `authenticate` can make, spied so that the claim in this
 * file's header — nothing reaches Postgres — is asserted and not assumed.
 *
 * `touchSession` fires an `UPDATE sesiones` when the row's `last_used_at` is
 * older than the throttle. The fixture below sets it to now, so today it never
 * fires — but that is the throttle constant doing the work, not this file, and
 * lowering it would have sent a real UPDATE to the configured database with
 * every test still green. Rejecting rather than resolving: if it ever runs, the
 * request still answers (the touch is fire-and-forget), and the spy's call
 * count is what `reached the database on the happy path` would show.
 */
const sesionUpdate = vi.spyOn(SesionModel, "update");

const adssFindAll = vi.spyOn(AdssModel, "findAll");
const ciudadFindAll = vi.spyOn(CiudadModel, "findAll");
const materialFindAll = vi.spyOn(MaterialModel, "findAll");
const obsFindAll = vi.spyOn(ObsModel, "findAll");
const posteFindAll = vi.spyOn(PosteModel, "findAll");
const propietarioFindAll = vi.spyOn(PropietarioModel, "findAll");
const tipoObsFindAll = vi.spyOn(TipoObsModel, "findAll");
const tramoFindAll = vi.spyOn(TramoModel, "findAll");
const departamentoFindAll = vi.spyOn(DepartamentoModel, "findAll");

/**
 * The two queries that prove the ordering, by never running.
 *
 * `searchPoste` reads `PosteModel.findOne` and `searchEvento` reads
 * `EventoModel.findOne` — the handlers behind `/:id` on the two routers that
 * have one. Spied so that a shadowed literal fails loudly here instead of
 * reaching for the configured database.
 */
const posteFindOne = vi.spyOn(PosteModel, "findOne");
const eventoFindOne = vi.spyOn(EventoModel, "findOne");

const YO = 7;
const MI_ROL = 2;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
/**
 * A year back, and older than the session below.
 *
 * `authenticate` refuses a session opened before the password last changed, so
 * a recent value here would turn every test in this file into a 401 about a
 * password none of them touches.
 */
const PASS_CAMBIADA = new Date(Date.now() - 365 * 86_400_000);

/** Two live cities. */
const CIUDADES = [
  { id: 3, name: "Tacna", lat: -18.01, lng: -70.25 },
  { id: 7, name: "Ilo", lat: -17.64, lng: -71.34 },
];

/** A tramo row as `INCLUDE_TRAMO` brings it back: the two ends by id, with their names. */
const crudo = (extra: Record<string, unknown> = {}) => ({
  id: 14,
  id_ciudad_min: 3,
  id_ciudad_max: 7,
  id_departamento: 5,
  deletedAt: null,
  ciudadMin: { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ciudadMax: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  departamento: { id: 5, name: "Potosí" },
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  puede = true;
  // A live session belonging to YO. `last_used_at` is now on purpose: the touch
  // is throttled, so a fresh stamp keeps `touchSession` from firing an UPDATE.
  // `mfa_satisfied_at` and `mfa_source` are null because that is what every
  // session in production has — nothing writes those columns yet.
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

  adssFindAll.mockResolvedValue([{ id: 1, name: "ADSS 24" }] as never);
  ciudadFindAll.mockResolvedValue(CIUDADES as never);
  materialFindAll.mockResolvedValue([{ id: 1, name: "Madera" }] as never);
  obsFindAll.mockResolvedValue([{ id: 1, name: "Poste inclinado", id_tipoObs: 2 }] as never);
  propietarioFindAll.mockResolvedValue([{ id: 1, name: "Electrosur" }] as never);
  tipoObsFindAll.mockResolvedValue([{ id: 2, name: "Estructural" }] as never);
  // Left rejecting: the tramos no longer come from the pole register, and a bare
  // spy would call through to the configured database if anything went back to it.
  posteFindAll.mockRejectedValue(new Error("PosteModel.findAll corrió: las opciones ya no leen el registro de postes") as never);
  tramoFindAll.mockResolvedValue([crudo()] as never);
  departamentoFindAll.mockResolvedValue([{ id: 5, name: "Potosí" }] as never);
  // Left rejecting: nothing in this file should reach either, and a bare spy
  // would answer `undefined` and let a shadowed route look merely empty.
  posteFindOne.mockRejectedValue(new Error("searchPoste corrió: /options quedó tapada por /:id") as never);
  eventoFindOne.mockRejectedValue(new Error("searchEvento corrió: /options quedó tapada por /:id") as never);
  sesionUpdate.mockRejectedValue(new Error("touchSession corrió: este test habría escrito en la base de datos") as never);
});

/** What the handler asked Sequelize for, on the nth call of that spy. */
const consulta = (spy: { mock: { calls: unknown[][] } }, n = 0) =>
  spy.mock.calls[n]?.[0] as
    | { attributes?: unknown; order?: unknown; raw?: unknown; group?: unknown }
    | undefined;

describe("the options endpoints are mounted where they can be reached", () => {
  it("answers /api/poste/options without ever reaching searchPoste", async () => {
    const res = await request(app).get("/api/poste/options").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    // The assertion this endpoint exists for. `/:id` is declared three lines
    // below `/options`; declared three lines above, this spy is what runs.
    expect(posteFindOne, "el literal /options no ganó al paramétrico /:id").not.toHaveBeenCalled();
  });

  it("answers /api/evento/options without ever reaching searchEvento", async () => {
    const res = await request(app).get("/api/evento/options").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(eventoFindOne, "el literal /options no ganó al paramétrico /:id").not.toHaveBeenCalled();
  });

  it("answers /api/reporte/options", async () => {
    // No `/:id` on this router to lose to, so there is nothing to prove about
    // ordering here — only that the mount exists and the chain does not 500.
    const res = await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
    expect(res.status).toBe(200);
  });

  it("still serves the parametric route it was declared in front of", async () => {
    // The other direction, and it is not symmetry for its own sake: declaring a
    // literal first is only correct if it does not swallow the parametric route
    // in turn. A single-segment literal cannot, but this is what would notice a
    // future `/options/:algo` or a `/:id` accidentally removed.
    posteFindOne.mockResolvedValue({ dataValues: { id: 5, name: "P-5" } } as never);
    const res = await request(app).get("/api/poste/5").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(posteFindOne).toHaveBeenCalled();
  });
});

describe("what each endpoint answers with", () => {
  it("gives the pole form its lists and nothing else", async () => {
    const res = await request(app).get("/api/poste/options").set("Cookie", COOKIE);

    // Both directions: a missing block and an extra one both fail. A block
    // nobody asked for is a column of the database being published by accident.
    // The tramos and the departments are there so the form can offer a tramo, and
    // create one, without another gate.
    expect(Object.keys(res.body).sort()).toEqual(["adss", "ciudad", "departamento", "material", "propietario", "tramos"]);
  });

  it("gives both incident forms their two lists and nothing else", async () => {
    const res = await request(app).get("/api/evento/options").set("Cookie", COOKIE);

    // Deliberately no `poste` block: `AddEventoPageSheet` does need the pole
    // list, and serving the pole register under `eventos.ver` would be worse
    // than the problem it solves. §5.5 leaves that to C3.
    expect(Object.keys(res.body).sort()).toEqual(["obs", "tipoObs"]);
  });

  it("gives the report screens their six lists and nothing else", async () => {
    const res = await request(app).get("/api/reporte/options").set("Cookie", COOKIE);

    expect(Object.keys(res.body).sort())
      .toEqual(["adss", "ciudad", "material", "obs", "propietario", "tramos"]);
  });
});

describe("what each block asks the database for", () => {
  // Read off the spies rather than off the response: the rows in the response
  // are this file's own fixtures, so their keys would prove nothing. The
  // `attributes` list is what actually decides the columns.

  it("asks for the cities the pole form can draw", async () => {
    await request(app).get("/api/poste/options").set("Cookie", COOKIE);

    // `lat` and `lng` are the two that matter. `PosteSheet` draws a map and
    // `ReportRecorrido` traces a line with them, and both guard with
    // `if (!a?.lat …)` — without the columns they render nothing, with no error.
    expect(consulta(ciudadFindAll)?.attributes).toEqual(["id", "name", "lat", "lng"]);
  });

  it("asks for the observations the incident forms can group", async () => {
    await request(app).get("/api/evento/options").set("Cookie", COOKIE);

    // `id_tipoObs` is the one that matters: both forms group with
    // `filter(o => o.id_tipoObs === …)`, and without it every group is empty —
    // which reads on screen as "no observations configured", not as an error.
    expect(consulta(obsFindAll)?.attributes).toEqual(["id", "name", "id_tipoObs"]);
    expect(consulta(tipoObsFindAll)?.attributes).toEqual(["id", "name"]);
  });

  it("asks the three plain catalogues for a name and nothing more", async () => {
    await request(app).get("/api/poste/options").set("Cookie", COOKIE);

    // `description` exists on adss and material and is read by the Parámetros
    // sections, which stay on the administration endpoints (§5.5). A dropdown
    // does not need it and should not carry it.
    expect(consulta(adssFindAll)?.attributes).toEqual(["id", "name"]);
    expect(consulta(materialFindAll)?.attributes).toEqual(["id", "name"]);
    expect(consulta(propietarioFindAll)?.attributes).toEqual(["id", "name"]);
  });

  it("asks the report screens' six blocks for their own columns", async () => {
    // Its own test, and not a line added to the three above, because the
    // projections are decided per call site: `getOpcionesReporte` names
    // `CIUDAD_DIBUJABLE` and `NOMBRE` on its own lines, and the assertions above
    // read the calls the *pole* and *incident* endpoints made. Reducing this
    // endpoint's city to `id, name` used to leave the whole suite green — and
    // `ReportRecorrido`'s `if (a?.lat && a?.lng && …)` falls out on its first
    // line, so the screen called Recorrido draws no recorrido and logs nothing.
    await request(app).get("/api/reporte/options").set("Cookie", COOKIE);

    expect(consulta(ciudadFindAll)?.attributes).toEqual(["id", "name", "lat", "lng"]);
    // `NOMBRE` here and `OBS_AGRUPABLE` on the incident endpoint, deliberately:
    // the report screens read `obs.name` for a column header and never group.
    expect(consulta(obsFindAll)?.attributes).toEqual(["id", "name"]);
    expect(consulta(adssFindAll)?.attributes).toEqual(["id", "name"]);
    expect(consulta(materialFindAll)?.attributes).toEqual(["id", "name"]);
    expect(consulta(propietarioFindAll)?.attributes).toEqual(["id", "name"]);
    // The tramos are read from their own table now, in the columns the
    // presenter needs and in id order before it sorts them by name.
    expect(consulta(tramoFindAll)?.attributes).toEqual(INCLUDE_TRAMO.attributes);
    expect(consulta(tramoFindAll)?.order).toEqual([["id", "ASC"]]);
  });

  it("asks for plain rows, not model instances", async () => {
    // `raw: true` is what makes a projection carry exactly the columns asked
    // for. Asserted because nothing else here would notice its absence: a
    // Sequelize instance serialises to the same JSON, so the response would look
    // identical while every row arrived wrapped.
    await request(app).get("/api/poste/options").set("Cookie", COOKIE);
    for (const spy of [adssFindAll, ciudadFindAll, materialFindAll, propietarioFindAll]) {
      expect(consulta(spy)?.raw).toBe(true);
    }
  });

  it("orders every list, because an export's columns follow it", async () => {
    await request(app).get("/api/reporte/options").set("Cookie", COOKIE);

    // Not decoration. `ReportTramoSec` builds one table column per propietario,
    // per material, per ADSS and per observation in list order, and hands the
    // same lists to the Excel and PDF exporters. A `findAll` with no `order`
    // gets Postgres's heap order, which moves after an UPDATE or a VACUUM — so
    // the columns of a saved report would rearrange between runs with nothing on
    // screen to explain it. `id DESC` matches what every catalogue endpoint in
    // this API already does, which is also what keeps C2 invisible.
    for (const spy of [ciudadFindAll, adssFindAll, materialFindAll, propietarioFindAll, obsFindAll]) {
      expect(consulta(spy)?.order).toEqual([["id", "DESC"]]);
    }
  });

  it("never asks for archived rows", async () => {
    await request(app).get("/api/reporte/options").set("Cookie", COOKIE);

    // §5: "los archivados no viajan". All seven models are `paranoid: true`, so
    // this is satisfied by the *absence* of `paranoid: false` — which is exactly
    // the kind of thing that gets pasted in from a neighbouring controller,
    // where it is there on purpose so an archived city can still label a pole
    // that exists. Asserted as absence for that reason.
    for (const spy of [ciudadFindAll, adssFindAll, materialFindAll, propietarioFindAll, obsFindAll, tramoFindAll]) {
      expect(consulta(spy)).not.toHaveProperty("paranoid");
      expect(consulta(spy)).not.toHaveProperty("where");
    }
  });
});

describe("the tramos block", () => {
  it("serves every live tramo, presented and in the order of its name", async () => {
    tramoFindAll.mockResolvedValue([
      crudo({ id: 2, ciudadMin: { id: 1, name: "Tarija" }, ciudadMax: { id: 9, name: "Sucre" } }),
      crudo({ id: 1, ciudadMin: { id: 3, name: "Beni" }, ciudadMax: { id: 4, name: "Oruro" } }),
    ] as never);
    const res = await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
    expect(res.body.tramos.map((t: { nombre: string }) => t.nombre)).toEqual(["Beni – Oruro", "Sucre – Tarija"]);
    expect(JSON.stringify(res.body.tramos)).not.toMatch(/id_ciudad_(min|max)|id_ciudadA/);
  });

  it("leaves archived tramos out of a list of choices, and keeps their cities' names in", async () => {
    await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
    // The tramo itself: default paranoid, so `paranoid` is not passed as false.
    expect((consulta(tramoFindAll) as { paranoid?: boolean })?.paranoid).not.toBe(false);
    // Its cities: asked for even when archived, so the name is whole.
    const incluye = (consulta(tramoFindAll) as unknown as { include: { as?: string; paranoid: boolean }[] }).include;
    const ciudades = incluye.filter((i) => i.as?.startsWith("ciudad"));
    expect(ciudades).toHaveLength(2);
    expect(ciudades.every((i) => i.paranoid === false)).toBe(true);
  });

  it("no longer derives tramos from the pole register", async () => {
    await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
    expect(posteFindAll).not.toHaveBeenCalled();
  });

  it("gives the pole form its tramos and the departments, so it can create a tramo without another gate", async () => {
    const res = await request(app).get("/api/poste/options").set("Cookie", COOKIE);
    expect(Object.keys(res.body).sort()).toEqual(["adss", "ciudad", "departamento", "material", "propietario", "tramos"]);
    expect(res.body.departamento).toEqual([{ id: 5, name: "Potosí" }]);
    expect(res.body.tramos.map((t: { nombre: string }) => t.nombre)).toEqual(["Potosí – Sucre"]);
    expect(consulta(departamentoFindAll)?.order).toEqual([["id", "ASC"]]);
  });
});

describe("the tramo dialog's lists", () => {
  it("asks for the cities with their coordinates and photo, so the network editor can draw and edit them", async () => {
    await request(app).get("/api/tramo/options").set("Cookie", COOKIE);

    expect(consulta(ciudadFindAll)?.attributes).toEqual(["id", "name", "lat", "lng", "image"]);
  });

  it("answers each city with id, name, lat, lng and image and nothing more, beside the departments and, for an editor, the accounts", async () => {
    const conFoto = [
      { id: 3, name: "Tacna", lat: -18.01, lng: -70.25, image: "uploads/tacna.jpg" },
      { id: 7, name: "Ilo", lat: -17.64, lng: -71.34, image: null },
    ];
    ciudadFindAll.mockResolvedValue(conFoto as never);

    const res = await request(app).get("/api/tramo/options").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    // `can` answers yes to everything here; the editor's half is in `opciones.tramo.test.ts`.
    expect(Object.keys(res.body).sort()).toEqual(["ciudad", "departamento", "usuarios"]);
    expect(res.body.ciudad).toEqual(conFoto);
    expect(res.body.departamento).toEqual([{ id: 5, name: "Potosí" }]);
  });

  it("does not widen the pole form's cities with the photo", async () => {
    await request(app).get("/api/poste/options").set("Cookie", COOKIE);

    expect(consulta(ciudadFindAll)?.attributes).not.toContain("image");
  });
});

describe("who may call them", () => {
  it("refuses all three to an account without the permission", async () => {
    puede = false;

    for (const url of ["/api/poste/options", "/api/evento/options", "/api/reporte/options"]) {
      const res = await request(app).get(url).set("Cookie", COOKIE);
      expect(res.status, `${url} contestó ${res.status}`).toBe(403);
    }
  });

  it("refuses all three to a request with no session at all", async () => {
    for (const url of ["/api/poste/options", "/api/evento/options", "/api/reporte/options"]) {
      const res = await request(app).get(url);
      expect(res.status, `${url} contestó ${res.status}`).toBe(401);
    }
  });

  it("reached the database on the happy path, so the tests above are not vacuous", async () => {
    // Every assertion in this file reads a spy, and a spy that was never called
    // answers `undefined` — which `toEqual(undefined)` would happily accept if
    // one of the expectations above were ever loosened. This is the guard the
    // four source-level tests in `src/controllers/` all carry, in the form this
    // file needs it.
    await request(app).get("/api/poste/options").set("Cookie", COOKIE);
    await request(app).get("/api/evento/options").set("Cookie", COOKIE);
    await request(app).get("/api/reporte/options").set("Cookie", COOKIE);

    for (const spy of [adssFindAll, ciudadFindAll, materialFindAll, obsFindAll, propietarioFindAll, tipoObsFindAll, tramoFindAll, departamentoFindAll]) {
      expect(spy).toHaveBeenCalled();
    }
    // And the one write on the request path never ran. If this ever fails, the
    // session touch reached past the throttle — and, unspied, it would have
    // reached the database.
    expect(sesionUpdate, "touchSession intentó escribir la sesión").not.toHaveBeenCalled();
  });
});
