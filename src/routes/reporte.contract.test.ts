// The six fixed reports, through the real Express stack.
//
// Nothing exercised `/api/reporte` over HTTP before this file: not the method,
// not the address, not the gate. One of the six had unit coverage
// (`reporte.tiempos.test.ts`, which is good and stays), and the only other test
// that touched these controllers skips itself when there is no Postgres — which
// is worse than nothing, because it reports green without having run. So this is
// the first deliverable of task C1, and the method change is the second.
//
// **What is asserted, and what would be theatre.** Three of the six hand the
// result of a `findAll` straight to `res.json`. Asserting the body's shape would
// be reading this file's own fixtures back, so the body is only used where the
// handler *computed* something. What the tests read instead is:
//
//   - **the method, the address and the gate**, which only a request can
//     establish;
//   - **the `where` the handler builds**, read off the spy — for the three
//     listing reports that is the entire endpoint, and it is where the
//     `excludeOld` trap lives;
//   - **the aggregation**, for the two reports that had no coverage at all
//     (`estado-red` and `obs-frecuencia`), driven by fixed rows.
//
// Models are spied and not mocked: `vi.mock` on a model breaks the association
// graph for every router `app.ts` loads, which `opciones.test.ts` and
// `bitacora.autores.test.ts` both document. Nothing here reaches Postgres, and
// in this environment that is not a nicety — the configured database is a copy
// of production.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

let puede = true;
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => ({ reportes: { ver: true } }),
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));

const app = (await import("../app.js")).default;
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { EventoModel } = await import("../models/evento.model.js");
const { PosteModel } = await import("../models/poste.model.js");
const { RevisionModel } = await import("../models/revision.model.js");
const { SolucionModel } = await import("../models/solucion.model.js");
const { EventoObsModel } = await import("../models/eventoObs.model.js");
const { Op } = await import("sequelize");
const { consultaLimiter } = await import("../middleware/limiters.js");
const { sequelize } = await import("../database/sequelize.js");
const { allowedOrigins, CSRF_CLIENT_HEADER } = await import("../config/security.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
// Tripwires, not fixtures. Nothing in this file may reach the database, and the
// shared-budget block at the end asks the generator's query route — refused by
// the budget and never run, but if the budget were not shared it would try to.
// `buildQuery` refuses an empty configuration before any SQL, so this is a
// tripwire behind a tripwire; it stays, because the database is a copy of
// production.
const sequelizeQuery = vi.spyOn(sequelize, "query");
const sequelizeTransaction = vi.spyOn(sequelize, "transaction");

const eventoFindAll = vi.spyOn(EventoModel, "findAll");
const posteFindAll = vi.spyOn(PosteModel, "findAll");
const revisionFindAll = vi.spyOn(RevisionModel, "findAll");
const solucionFindAll = vi.spyOn(SolucionModel, "findAll");
const eventoObsFindAll = vi.spyOn(EventoObsModel, "findAll");

const YO = 7;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const PASS_CAMBIADA = new Date(Date.now() - 365 * 86_400_000);
const RANGO = "fechaInicial=2026-01-01&fechaFinal=2026-03-31";

/** The six, by address, with a filter each one accepts. */
const LOS_SEIS = [
  ["general", RANGO],
  ["tramo", RANGO],
  ["recorrido", `${RANGO}&TramoInicial=3&TramoFinal=7`],
  ["estado-red", ""],
  ["obs-frecuencia", RANGO],
  ["tiempos-resumen", RANGO],
] as const;

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
    dataValues: { id: YO, id_rol: 2, user: "isaias", name: "Isaias", lastname: "Salas", image: null, pass_changed_at: PASS_CAMBIADA },
  } as never);

  eventoFindAll.mockResolvedValue([] as never);
  posteFindAll.mockResolvedValue([] as never);
  revisionFindAll.mockResolvedValue([{ dataValues: { id_evento: 1 } }] as never);
  solucionFindAll.mockResolvedValue([{ dataValues: { id_evento: 1 } }] as never);
  eventoObsFindAll.mockResolvedValue([] as never);
  sesionUpdate.mockRejectedValue(new Error("touchSession corrió: habría escrito en la base de datos") as never);
  sequelizeQuery.mockRejectedValue(new Error("sequelize.query corrió: habría consultado la base de datos") as never);
  sequelizeTransaction.mockRejectedValue(new Error("sequelize.transaction corrió: habría consultado la base de datos") as never);

  // 🔴 The budget is thirty a minute (B3), and everything here asks as user 7.
  // Before the B3 block at the end existed, this file charged 32 requests and
  // the first 429 landed on the second line of the anti-vacuity test: the
  // failure read "posteFindAll was not called" — the wrong cause, named with
  // confidence. With that block the file charges 126, and three of its tests
  // spend exactly thirty before asserting the refusal, so there is no margin
  // inside them: the reset is per test, not per file. Reset rather than
  // mocked, as `listShape.test.ts` does with `exportLimiter`: that the budget
  // really is mounted is what the last block measures.
  consultaLimiter.resetKey(`u:${YO}`);
});

const pedir = (ruta: string, filtro = RANGO) =>
  request(app).get(`/api/reporte/${ruta}${filtro ? `?${filtro}` : ""}`).set("Cookie", COOKIE);

/** The options object of the nth call to a spy. */
const consulta = (spy: { mock: { calls: unknown[][] } }, n = 0) =>
  spy.mock.calls[n]?.[0] as { where?: Record<string, unknown>; attributes?: unknown; include?: unknown[] } | undefined;

describe("the method and the address", () => {
  it("answers all six on GET", async () => {
    for (const [ruta, filtro] of LOS_SEIS) {
      const res = await pedir(ruta, filtro);
      expect(res.status, `${ruta} contestó ${res.status}: ${JSON.stringify(res.body).slice(0, 120)}`).toBe(200);
    }
  });

  it("no longer answers any of them on PUT", async () => {
    // The other half of the move, and the one a half-finished migration would
    // leave passing: three routes moved and three still mounted both ways looks
    // exactly like success from the GET side alone.
    for (const [ruta] of LOS_SEIS) {
      const res = await request(app).put(`/api/reporte/${ruta}`).set("Cookie", COOKIE).send({});
      expect(res.status, `PUT /${ruta} contestó ${res.status}`).not.toBe(200);
    }
  });

  it("tells a cache not to keep a report", async () => {
    // As `PUT` these were unstorable by definition. As `GET` they are storable
    // by default, and what stops a copy being kept is heuristics rather than
    // anything written down — until a CDN is put in front of the API.
    const res = await pedir("general");

    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("who may ask", () => {
  it("refuses all six without the permission", async () => {
    puede = false;

    for (const [ruta, filtro] of LOS_SEIS) {
      const res = await pedir(ruta, filtro);
      expect(res.status, ruta).toBe(403);
    }
  });

  it("refuses all six without a session", async () => {
    for (const [ruta, filtro] of LOS_SEIS) {
      const res = await request(app).get(`/api/reporte/${ruta}?${filtro}`);
      expect(res.status, ruta).toBe(401);
    }
  });
});

describe("the filter, now that it travels in the URL", () => {
  it("refuses a date that is not one, instead of answering 500", async () => {
    // The defect §3.5 names: `new Date("ayer")` reached Postgres as the literal
    // text `Invalid date`, and the caller was told nothing it could act on.
    const res = await pedir("general", "fechaInicial=ayer&fechaFinal=2026-03-31");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fechas/i);
    expect(eventoFindAll, "llegó a consultar con una fecha inválida").not.toHaveBeenCalled();
  });

  it("demands a period on the five that need one, and not on estado-red", async () => {
    for (const [ruta] of LOS_SEIS.filter(([r]) => r !== "estado-red")) {
      const res = await pedir(ruta, "");
      expect(res.status, ruta).toBe(400);
    }
    expect((await pedir("estado-red", "")).status).toBe(200);
  });

  it("demands both ends of the stretch on recorrido alone", async () => {
    expect((await pedir("recorrido", RANGO)).status).toBe(400);
    expect((await pedir("tramo", RANGO)).status).toBe(200);
  });

  it("reads excludeOld as a word, not as a truthy string", async () => {
    // The trap the move introduces, and the only defect here that produces a
    // plausible report instead of an error. `"false"` is truthy, so read raw the
    // switch would be stuck on: `date` would be added to the query and the
    // carried-over incidents dropped, while the screen shows the switch off.
    await pedir("general", `${RANGO}&excludeOld=false`);
    expect(consulta(eventoFindAll)?.where).not.toHaveProperty("date");

    vi.clearAllMocks();
    eventoFindAll.mockResolvedValue([] as never);
    revisionFindAll.mockResolvedValue([{ dataValues: { id_evento: 1 } }] as never);

    await pedir("general", `${RANGO}&excludeOld=true`);
    expect(consulta(eventoFindAll)?.where).toHaveProperty("date");
  });

  it("refuses a repeated parameter rather than widening the report", async () => {
    // Express builds an array from a repeated key. Read as "not sent", a
    // repeated `TramoInicial` means *no stretch at all*, so the report covers
    // every pole in the network while the URL names two cities.
    const res = await pedir("tramo", `${RANGO}&TramoInicial=1&TramoInicial=2`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/tramo/i);
  });
});

describe("what the stretch does to the query", () => {
  it("narrows tramo by the pair, in both directions", async () => {
    await pedir("tramo", `${RANGO}&TramoInicial=3&TramoFinal=7`);

    // A stretch is bidirectional: 3→7 and 7→3 are the same line, and a filter
    // that names only one order silently halves the report. Read through the
    // `Op.or` symbol rather than serialised — `JSON.stringify` drops symbol keys
    // and turns this whole condition into `{}`, which is what the first version
    // of this assertion was comparing against.
    const poste = (consulta(eventoFindAll)?.include as { model: unknown; where?: unknown; required?: boolean }[])
      ?.find((i) => i.model === PosteModel);
    const pares = (poste?.where as Record<symbol, unknown> | undefined)?.[Op.or];
    expect(pares).toEqual([
      { id_ciudadA: 3, id_ciudadB: 7 },
      { id_ciudadA: 7, id_ciudadB: 3 },
    ]);
    // `required` is what turns the include into an inner join: without it the
    // filter narrows nothing, because every incident comes back with a null pole.
    expect(poste?.required).toBe(true);
  });

  it("does not narrow tramo when no stretch is named", async () => {
    await pedir("tramo", RANGO);

    const poste = (consulta(eventoFindAll)?.include as { model: unknown; where?: unknown; required?: boolean }[])
      ?.find((i) => i.model === PosteModel);
    expect(poste?.where).toBeUndefined();
    expect(poste?.required).toBe(false);
  });
});

describe("estado de la red, which had no coverage at all", () => {
  /** One pole on the stretch between two cities, with `n` pending incidents. */
  const poste = (id: number, a: number, b: number, pendientes: number, total = pendientes) => ({
    toJSON: () => ({
      id,
      id_ciudadA: a,
      id_ciudadB: b,
      ciudadA: { id: a, name: `C${a}` },
      ciudadB: { id: b, name: `C${b}` },
      eventos: Array.from({ length: total }, (_, i) => ({ id: i + 1, state: i >= pendientes })),
    }),
  });

  it("counts the two directions of a stretch as one", async () => {
    // (1,2) and (2,1) are the same line. Counted apart, every stretch in the
    // report is split in two and both halves read as half as busy.
    posteFindAll.mockResolvedValue([poste(1, 1, 2, 1), poste(2, 2, 1, 1)] as never);

    const res = await pedir("estado-red", "");

    expect(res.body).toHaveLength(1);
    expect(res.body[0].totalPostes).toBe(2);
  });

  it("names the two cities in a stable order", async () => {
    posteFindAll.mockResolvedValue([poste(1, 2, 1, 0)] as never);

    const res = await pedir("estado-red", "");

    // Normalised by id, so the same stretch reads the same whichever way round
    // its poles were recorded. Crossed, the report would name the wrong city
    // first for half of them.
    expect(res.body[0].ciudadAId).toBe(1);
    expect(res.body[0].ciudadAName).toBe("C1");
    expect(res.body[0].ciudadBId).toBe(2);
  });

  it("calls a stretch with no incidents perfectly healthy", async () => {
    // Zero incidents is 100 % health, not 0 %. The division has to be guarded,
    // and the wrong guard puts every quiet stretch at the top of a list sorted
    // worst-first.
    posteFindAll.mockResolvedValue([poste(1, 1, 2, 0, 0)] as never);

    const res = await pedir("estado-red", "");

    expect(res.body[0].pctSalud).toBe(100);
  });

  it("counts a pole as troubled only when something is actually pending", async () => {
    posteFindAll.mockResolvedValue([poste(1, 1, 2, 0, 3), poste(2, 1, 2, 2, 2)] as never);

    const res = await pedir("estado-red", "");

    // Two poles, one of them with pending work. `>= 0` instead of `> 0` would
    // report both, and the screen would say the whole network is in trouble.
    expect(res.body[0].totalPostes).toBe(2);
    expect(res.body[0].conPendientes).toBe(1);
  });

  it("puts the worst stretch first", async () => {
    posteFindAll.mockResolvedValue([
      poste(1, 1, 2, 0, 2),
      poste(2, 3, 4, 2, 2),
    ] as never);

    const res = await pedir("estado-red", "");

    // Ascending by health: the point of the screen is what needs attention.
    // Reversed, the list opens on everything that is fine.
    expect(res.body[0].pctSalud).toBeLessThanOrEqual(res.body[1].pctSalud);
    expect(res.body[0].ciudadAId).toBe(3);
  });
});

describe("frecuencia de observaciones, which had no coverage either", () => {
  const fila = (idObs: number, nombre: string, tipo: string | null, criticidad: number | null) => ({
    toJSON: () => ({
      id_obs: idObs,
      ob: { id: idObs, name: nombre, criticality: criticidad, tipoObs: tipo ? { id: 1, name: tipo } : null },
    }),
  });

  it("counts each observation once per appearance", async () => {
    eventoObsFindAll.mockResolvedValue([
      fila(1, "Poste inclinado", "Estructural", 3),
      fila(1, "Poste inclinado", "Estructural", 3),
      fila(2, "Cable suelto", "Eléctrico", 2),
    ] as never);

    const res = await pedir("obs-frecuencia");

    const inclinado = (res.body as { obs: string; count: number; pct: number }[]).find((r) => r.obs === "Poste inclinado");
    expect(inclinado?.count).toBe(2);
    // The percentage is over the total, not over the group: two of three.
    expect(inclinado?.pct).toBeCloseTo(66.7, 0);
  });

  it("survives an observation with no type and no criticality", async () => {
    // Both are nullable in the database. A row that cannot be labelled must not
    // take the report down, and it must not be silently dropped either.
    eventoObsFindAll.mockResolvedValue([fila(3, "Sin clasificar", null, null)] as never);

    const res = await pedir("obs-frecuencia");

    expect(res.body).toHaveLength(1);
    expect(res.body[0].tipoObs).toBe("—");
    expect(res.body[0].criticality).toBeNull();
  });

  it("skips a row whose observation no longer exists", async () => {
    eventoObsFindAll.mockResolvedValue([
      { toJSON: () => ({ id_obs: 9, ob: null }) },
      fila(1, "Poste inclinado", "Estructural", 3),
    ] as never);

    const res = await pedir("obs-frecuencia");

    expect(res.body).toHaveLength(1);
    expect(res.body[0].obs).toBe("Poste inclinado");
  });
});

describe("nothing reached the database", () => {
  it("used the spies on the happy path, so the assertions above are not vacuous", async () => {
    await pedir("general");
    await pedir("estado-red", "");
    await pedir("obs-frecuencia");

    expect(eventoFindAll).toHaveBeenCalled();
    expect(posteFindAll).toHaveBeenCalled();
    expect(eventoObsFindAll).toHaveBeenCalled();
    expect(sesionUpdate, "touchSession intentó escribir la sesión").not.toHaveBeenCalled();
  });
});

/**
 * The budget — B3.
 *
 * `consultaLimiter` is the generator's thirty a minute, and since B3 the six
 * reports draw from it too, by decision. These three tests are that decision
 * made measurable through the real stack, and each names what it is for. The
 * first pins the number and that a refused request runs no query. The second
 * pins the order, and is only meaningful next to the first: an unmounted budget
 * would also "not be spent" by a 403. The third pins the sharing in both
 * directions, because a `/consulta` that answered 429 whatever happened would
 * satisfy one direction alone.
 *
 * Thirty, written by hand every time. Read off the limiter it would only prove
 * the code agrees with itself.
 */
describe("the budget the six share with the generator (B3)", () => {
  const AVISO = "Demasiadas consultas seguidas. Espere un momento e intente de nuevo.";
  /** What `requireSameOrigin` asks of a POST; the origin is the configured one. */
  const DEL_FRONTEND = {
    Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0],
    [CSRF_CLIENT_HEADER]: "web",
  };
  /**
   * The generator's query, as the front end sends it and with nothing in it.
   * Empty on purpose: if the budget were not shared this would reach the
   * handler, and an empty configuration is refused before any SQL. A valid one
   * would run against the configured database.
   */
  const consultaDelGenerador = () =>
    request(app).post("/api/generador/consulta").set("Cookie", COOKIE).set(DEL_FRONTEND).send({});

  it("answers the thirty-first report 429 with the sentence, and runs no query for it", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await pedir("general");
      expect(res.status, `la consulta ${i + 1} de 30`).toBe(200);
    }
    expect(eventoFindAll).toHaveBeenCalledTimes(30);

    const res = await pedir("general");

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: AVISO });
    // "Runs no query" is half the sentence: a handler that queried first and
    // refused after would pass the two lines above.
    expect(eventoFindAll).toHaveBeenCalledTimes(30);
    // `sinCache` runs first, so even the refusal is not for keeping.
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("does not charge a permission refusal: the budget sits behind the gate", async () => {
    puede = false;
    for (const [ruta, filtro] of LOS_SEIS) {
      expect((await pedir(ruta, filtro)).status, ruta).toBe(403);
    }
    puede = true;

    // Same `it`, no reset in between: that is what makes the thirtieth 200
    // mean "the six refusals cost nothing" rather than "the budget was fresh".
    for (let i = 0; i < 30; i++) {
      const res = await pedir("general");
      expect(res.status, `la consulta ${i + 1} de 30, tras seis rechazos`).toBe(200);
    }
    expect((await pedir("general")).status).toBe(429);
  });

  it("is one budget with the generator's query, in both directions", async () => {
    for (let i = 0; i < 30; i++) await pedir("general");

    // Spent on reports, refused on the generator: the decision itself.
    const refusal = await consultaDelGenerador();
    expect(refusal.status, JSON.stringify(refusal.body)).toBe(429);
    expect(refusal.body).toEqual({ message: AVISO });

    // The other direction, without which a `/consulta` answering 429 no matter
    // what would pass: with the budget reset, the same request reaches the
    // handler, which refuses the empty configuration — 400, not 429, and still
    // no SQL.
    consultaLimiter.resetKey(`u:${YO}`);
    const fresh = await consultaDelGenerador();
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(400);
    expect(sequelizeQuery).not.toHaveBeenCalled();
    expect(sequelizeTransaction).not.toHaveBeenCalled();
  });
});
