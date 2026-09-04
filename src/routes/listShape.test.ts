// One envelope for every listing, and the ledger that keeps the list honest.
//
// **This is the only thing in either repository that can tell "all eighteen
// migrated" from "fifteen migrated and three forgotten".** Before it, every
// listing in the API could be re-shaped — envelope to bare array or back — and
// both suites stayed green: 743 tests in `api`, 895 in `web`. That is not a gap
// in coverage, it is the absence of the contract itself.
//
// Two halves, and they fail for different reasons:
//
//   - **The ledger.** Every `GET` the app really mounts must appear in exactly
//     one of the four lists below. A route added tomorrow and left unclassified
//     fails here; a route deleted and left in a list fails here too. A
//     hand-written list is unavoidable — `res.json(x)` does not reveal the shape
//     of `x`, as §10 of the standard admits — but a hand-written list compared
//     against the mounted table in **both directions** cannot go stale. It is
//     the mechanism `routeGuards.test.ts` already uses for its permission table.
//   - **The shape.** Each listing is requested through the real stack and its
//     body must have exactly `data`, `total`, `page`, `limit`. Not a subset:
//     `totalPages` came back into an earlier draft with two type declarations
//     and zero readers, and a field nobody reads is one somebody eventually
//     computes wrong with nothing to notice.
//
// Nothing here reaches Postgres, and in this environment that is not a nicety:
// the configured database is a copy of production. Every query method these
// handlers touch is spied; the models stay real, because several declare their
// associations at import time and `vi.mock` on one of them breaks the graph for
// every router `app.ts` loads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { allowedOrigins, CSRF_CLIENT_HEADER } from "../config/security.js";

const permisos = { postes: { ver: true } };
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => permisos,
  can: async () => true,
  invalidatePermissions: vi.fn(),
}));

/**
 * The mounted `GET` table, captured the way `routeGuards.test.ts` captures it.
 *
 * Express 5 compiles a path into closures over a pattern nothing exposes, so
 * the prefixes have to be recorded as `app.use` receives them, during the import
 * of `app.js` and not after.
 */
const montajes: { prefijo: string; router: unknown }[] = [];
const express = (await import("express")).default;
const useOriginal = express.application.use;
express.application.use = function (this: Application, ...args: unknown[]) {
  // Every handler after the path, not just the first: a router is routinely
  // mounted behind its middleware — `app.use("/api/poste", authenticate,
  // posteRoutes)` — and taking `args[1]` captured the guard and lost the router.
  // It looked like it worked: four mounts came back instead of twenty-eight, and
  // the anti-vacuity check below is what said so.
  if (typeof args[0] === "string") {
    for (const handler of args.slice(1)) {
      if (typeof handler === "function") montajes.push({ prefijo: args[0], router: handler });
    }
  }
  return (useOriginal as (...a: unknown[]) => Application).apply(this, args);
} as typeof express.application.use;

const app = (await import("../app.js")).default;
express.application.use = useOriginal;

interface Capa {
  route?: { path: string; methods?: Record<string, boolean>; stack: { method?: string }[] };
}

/** Every `GET` the application really answers, as `METHOD /ruta`. */
const getsMontados = (): string[] => {
  const rutas: string[] = [];
  for (const { prefijo, router } of montajes) {
    const capas = (router as { stack?: Capa[] }).stack ?? [];
    for (const capa of capas) {
      if (!capa.route) continue;
      const metodos = capa.route.stack.map((c) => c.method).filter(Boolean);
      if (!metodos.includes("get")) continue;
      const sufijo = capa.route.path === "/" ? "/" : capa.route.path;
      rutas.push(`${prefijo}${sufijo === "/" ? "/" : sufijo}`);
    }
  }
  return rutas;
};

/** Every mounted route whose path ends in `/export`, whatever its verb. */
const exportsMontados = (): string[] => {
  const rutas: string[] = [];
  for (const { prefijo, router } of montajes) {
    const capas = (router as { stack?: Capa[] }).stack ?? [];
    for (const capa of capas) {
      if (!capa.route || !capa.route.path.endsWith("/export")) continue;
      for (const metodo of capa.route.stack.map((c) => c.method).filter(Boolean)) {
        rutas.push(`${(metodo as string).toUpperCase()} ${prefijo}${capa.route.path}`);
      }
    }
  }
  return rutas;
};

// ─── The ledger ───────────────────────────────────────────────────────────────

/**
 * A collection of rows of one table. Every one answers the envelope.
 *
 * Eighteen, and the five sub-resources are in here rather than exempt — the
 * pivot tables, the revisions, and the two incident lists. "It is usually only
 * a handful of rows" is exactly the weak criterion this arc exists to remove,
 * and two of the five are not bounded at all: the profile screen and the staff
 * detail screen both compute a resolution percentage from the length of
 * `/evento/usuario/:id`, so a truncated list did not look truncated — it looked
 * like an appraisal.
 */
const LISTADOS = [
  "/api/adss/",
  "/api/adssposte/:id_poste",
  "/api/bitacora/",
  "/api/bitacora/:id_usuario",
  "/api/ciudad/",
  "/api/evento/",
  "/api/evento/poste/:id_poste",
  "/api/evento/usuario/:id_usuario",
  "/api/eventoObs/:id_evento",
  "/api/material/",
  "/api/obs/",
  "/api/poste/",
  "/api/propietario/",
  "/api/revision/:id_evento",
  "/api/rol/",
  "/api/tipoObs/",
  "/api/usuario/",
];

/** One row, answered as the object — and **404** when there is no row. */
const DETALLES = [
  "/api/ciudad/:id",
  "/api/evento/:id",
  "/api/generador/reportes/:id",
  "/api/poste/:id",
  "/api/usuario/:id",
  "/api/usuario/user/:user",
];

/**
 * Neither a listing nor a detail: an object whose shape its own screen fixes.
 *
 * Each of these is exempt for a reason written in §3.3, and the two worth
 * repeating here are the ones a tidy-up would get wrong. `/solucion/evento/:id`
 * answers the object **or `null`**, and `null` is the ordinary case — an
 * unresolved incident; wrapping it would make `{data: null}`, which is truthy,
 * and **every pending incident would read as solved**. And `/generador/reportes`
 * pages by `offset` with `rows`, which its own client and a thousand lines of
 * its tests depend on.
 */
const AGREGADAS = [
  "/api/adss/stats",
  "/api/bitacora/autores",
  "/api/dashboard/",
  "/api/evento/opciones",
  "/api/files/broken-refs",
  "/api/files/entity-stats",
  "/api/files/orphans",
  "/api/generador/catalogo",
  "/api/generador/reportes",
  "/api/material/stats",
  "/api/obs/stats",
  "/api/permisos/",
  "/api/poste/opciones",
  "/api/propietario/stats",
  "/api/reporte/estado-red",
  "/api/reporte/general",
  "/api/reporte/obs-frecuencia",
  "/api/reporte/opciones",
  "/api/reporte/recorrido",
  "/api/reporte/tiempos-resumen",
  "/api/reporte/tramo",
  "/api/solucion/evento/:id_evento",
  "/api/tipoObs/stats",
];

/** Outside this document altogether: §2 stops at the authentication module. */
const FUERA = [
  "/api/auth/me",
  "/api/auth/sessions",
  "/api/auth/webauthn/credentials",
  "/api/auth/recovery-codes/",
];

describe("the ledger of every GET", () => {
  it("classifies every mounted route, and every classified route exists", () => {
    const montados = new Set(getsMontados());
    const clasificados = new Set([...LISTADOS, ...DETALLES, ...AGREGADAS, ...FUERA]);

    // Anti-vacuity first: an empty capture would satisfy both directions below.
    expect(montados.size).toBeGreaterThan(45);

    const sinClasificar = [...montados].filter((r) => !clasificados.has(r));
    expect(
      sinClasificar,
      "hay GET montados que ninguna lista de este fichero clasifica: decide si son " +
      "listado, detalle o agregada antes de que alguien lo decida a ojo",
    ).toEqual([]);

    const fantasmas = [...clasificados].filter((r) => !montados.has(r));
    expect(
      fantasmas,
      "estas rutas están clasificadas y no existen: la lista se quedó atrás",
    ).toEqual([]);
  });

  it("keeps the three groups apart", () => {
    const todos = [...LISTADOS, ...DETALLES, ...AGREGADAS, ...FUERA];
    expect(new Set(todos).size, "una ruta clasificada dos veces").toBe(todos.length);
  });
});

// ─── The shape ────────────────────────────────────────────────────────────────

const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { AdssModel } = await import("../models/adss.model.js");
const { AdssPosteModel } = await import("../models/adssPoste.model.js");
const { BitacoraModel } = await import("../models/bitacora.model.js");
const { CiudadModel } = await import("../models/ciudad.model.js");
const { EventoModel } = await import("../models/evento.model.js");
const { EventoObsModel } = await import("../models/eventoObs.model.js");
const { MaterialModel } = await import("../models/material.model.js");
const { ObsModel } = await import("../models/obs.model.js");
const { PosteModel } = await import("../models/poste.model.js");
const { PropietarioModel } = await import("../models/propietario.model.js");
const { RevisionModel } = await import("../models/revision.model.js");
const { RolModel } = await import("../models/rol.model.js");
const { TipoObsModel } = await import("../models/tipoObs.model.js");

/**
 * The audit log, spied so that a download does not write to the production copy.
 *
 * `logAction` swallows every failure by design, so a rejecting spy would prove
 * nothing here — it would look exactly like a handler that never logged. It
 * resolves, and the assertion is that it was **called**.
 */
const bitacoraCreate = vi.spyOn(BitacoraModel, "create").mockResolvedValue({} as never);

/**
 * The export budget, real and shared, and therefore reset between tests.
 *
 * `exportLimiter` is one instance mounted on four routes — the three downloads
 * and the report generator's — because what it rations is the single slot that
 * assembles documents. Ten a minute per person. This file makes more than ten
 * download requests, so without a reset the eleventh starts answering 429 and
 * a test fails for a reason that has nothing to do with what it is checking.
 * An audit caught this at eight of ten, before it bit.
 *
 * Reset rather than mocked: that the limiter is really mounted is itself worth
 * knowing, and the test at the end of this file checks that it bites.
 */
const { exportLimiter } = await import("../middleware/limiters.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const sesionUpdate = vi.spyOn(SesionModel, "update");

/** Every model a listing reads, by the address that reads it. */
const MODELOS = {
  "/api/adss/": AdssModel,
  "/api/adssposte/:id_poste": AdssPosteModel,
  "/api/bitacora/": BitacoraModel,
  "/api/bitacora/:id_usuario": BitacoraModel,
  "/api/ciudad/": CiudadModel,
  "/api/evento/": EventoModel,
  "/api/evento/poste/:id_poste": EventoModel,
  "/api/evento/usuario/:id_usuario": EventoModel,
  "/api/eventoObs/:id_evento": EventoObsModel,
  "/api/material/": MaterialModel,
  "/api/obs/": ObsModel,
  "/api/poste/": PosteModel,
  "/api/propietario/": PropietarioModel,
  "/api/revision/:id_evento": RevisionModel,
  "/api/rol/": RolModel,
  "/api/tipoObs/": TipoObsModel,
  "/api/usuario/": UsuarioModel,
} as const;

const espias = new Map(
  Object.values(MODELOS).map((m) => [m, vi.spyOn(m, "findAndCountAll")] as const),
);
/**
 * The tripwire the header promises.
 *
 * A listing that still calls `findAll` would reach the **configured database**,
 * which is a copy of production — and its rows would satisfy
 * `Array.isArray(body.data)` just as well as a fixture, so the test would pass
 * while querying production. Rejecting is what turns that into a failure.
 */
const findAllProhibido = Object.values(MODELOS).map((m) =>
  vi.spyOn(m, "findAll").mockRejectedValue(
    new Error("un listado sigue usando findAll: iría a la base de datos configurada") as never,
  ),
);

const YO = 7;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const PASS_CAMBIADA = new Date(Date.now() - 365 * 86_400_000);

/** An address with its parameters filled in, so supertest can ask for it. */
const concreta = (ruta: string) => ruta.replace(/:[A-Za-z_]+/g, "1");

beforeEach(() => {
  vi.clearAllMocks();
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
      image: null, pass_changed_at: PASS_CAMBIADA,
    },
  } as never);
  sesionUpdate.mockRejectedValue(
    new Error("touchSession corrió: este test habría escrito en la base de datos") as never,
  );
  for (const espia of espias.values()) {
    espia.mockResolvedValue({ count: 0, rows: [] } as never);
  }
  bitacoraCreate.mockResolvedValue({} as never);
  exportLimiter.resetKey(`u:${YO}`);
  for (const espia of findAllProhibido) {
    espia.mockRejectedValue(
      new Error("un listado sigue usando findAll: iría a la base de datos configurada") as never,
    );
  }
});

describe("every listing answers the same envelope", () => {
  for (const ruta of LISTADOS) {
    it(`${ruta}`, async () => {
      const res = await request(app).get(concreta(ruta)).set("Cookie", COOKIE);

      expect(res.status, `${ruta} contestó ${res.status}`).toBe(200);
      // Exactly these four, in both directions: one missing is a half-migrated
      // listing, one extra is `totalPages` coming back.
      expect(Object.keys(res.body).sort()).toEqual(["data", "limit", "page", "total"]);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(50);
    });
  }

  it("takes `total` from the count and never from the rows it happens to hold", async () => {
    // The assertion that separates a live client-side firewall from a dead one.
    // The obvious way to write `limit=all` is to reuse the old export branch and
    // set `total: rows.length`, and then `data.length < total` — the check the
    // client uses to refuse building a truncated file — is `n < n` and never
    // fires. It would look implemented and be inert.
    espias.get(PosteModel)!.mockResolvedValue(
      { count: 7, rows: [{ id: 1 }] } as never,
    );

    const res = await request(app).get("/api/poste/").set("Cookie", COOKIE);

    expect(res.body.total).toBe(7);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("the three details that used to answer 200 with nothing", () => {
  const posteFindOne = vi.spyOn(PosteModel, "findOne");
  const eventoFindOne = vi.spyOn(EventoModel, "findOne");
  const usuarioFindOne = vi.spyOn(UsuarioModel, "findOne");

  it("answer 404 when the row is not there", async () => {
    // Not tidiness. `PosteSheet` decides between editing and creating with
    // `!!poste?.id`, so a `null` body turned Editar into Nuevo and saved a
    // **duplicate pole**, announcing "Poste creado correctamente". And the pole
    // detail screen reads `dataPoste.id` with no guard, in an application that
    // has no error boundary anywhere: the whole app went white.
    posteFindOne.mockResolvedValue(null as never);
    eventoFindOne.mockResolvedValue(null as never);
    usuarioFindOne.mockResolvedValue(null as never);

    for (const ruta of ["/api/poste/1", "/api/evento/1", "/api/usuario/1"]) {
      const res = await request(app).get(ruta).set("Cookie", COOKIE);
      expect(res.status, `${ruta} contestó ${res.status}`).toBe(404);
      expect(res.body.message, ruta).toBeTruthy();
    }
  });

  it("still answer the object when the row is there", async () => {
    // The other direction: a handler that answered 404 unconditionally would
    // pass the test above.
    posteFindOne.mockResolvedValue({ id: 40, name: "P-001" } as never);

    const res = await request(app).get("/api/poste/40").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(40);
    // The object, not an envelope: a detail carries no collection metadata, and
    // wrapping it would give `data` to a screen that reads fields directly.
    expect(res.body.data).toBeUndefined();
  });
});

/**
 * The routes that answer with a **file**, and the fifth thing a route can be.
 *
 * They needed their own list because none of the four above fits and one of
 * them fits deceptively well: `AGREGADAS` is the bucket for "an object whose
 * shape its own screen fixes", it is never requested over HTTP by this file,
 * and putting a download in it would have left a green test whose sentence no
 * longer described what it checked. A spreadsheet is not an object.
 *
 * The sweep that keeps this honest is `/export`-suffixed **and any verb**, not
 * `GET` like the ledger above: these are POSTs, on purpose, because
 * `requireSameOrigin` guards only the writing verbs and a GET that assembles a
 * workbook is something a page anywhere can make an employee's browser do from
 * an `<img>` tag. Sweeping by GET alone would have classified none of them and
 * noticed nothing.
 *
 * **Its limit, said out loud:** the sweep recognises a download by the last
 * segment of its path. A future endpoint that returns a file from some other
 * address is invisible to it. That is a real gap and the alternative is worse
 * — there is no way to ask a mounted handler what it will send — so the
 * convention is the contract: a download is called `/export`. §3.4 already
 * fixes that spelling in English; `POST /api/generador/exportar` predates it
 * and is the one the rename in D1 is for.
 */
const DESCARGAS = [
  "POST /api/evento/export",
  "POST /api/poste/export",
  "POST /api/usuario/export",
];

describe("the ledger of every download", () => {
  it("classifies every mounted export, and every classified export exists", () => {
    const montadas = new Set(exportsMontados());
    const clasificadas = new Set(DESCARGAS);

    // Anti-vacuity: an empty capture would satisfy both directions below, and
    // this file has already been fooled once by exactly that.
    expect(montadas.size).toBe(3);

    expect(
      [...montadas].filter((r) => !clasificadas.has(r)),
      "hay exportaciones montadas que este fichero no clasifica",
    ).toEqual([]);
    expect(
      [...clasificadas].filter((r) => !montadas.has(r)),
      "estas exportaciones están clasificadas y no existen",
    ).toEqual([]);
  });

  it("never lets a download into one of the four JSON lists", () => {
    const json = [...LISTADOS, ...DETALLES, ...AGREGADAS, ...FUERA];
    for (const entrada of DESCARGAS) {
      const ruta = entrada.split(" ")[1];
      expect(json, `${ruta} está clasificada como respuesta JSON`).not.toContain(ruta);
    }
  });
});

/**
 * What a browser sends and a cross-site page cannot.
 *
 * The three downloads are POSTs, so `requireSameOrigin` guards them — which is
 * exactly why they are POSTs — and a request without these two is refused
 * before it reaches any handler. The origin is read off `allowedOrigins` rather
 * than written out, so it is the one this environment is really configured
 * with; the client header is checked for presence only, never for its value
 * (see `CSRF_CLIENT_HEADER`).
 */
const DEL_FRONTEND = {
  Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0],
  [CSRF_CLIENT_HEADER]: "web",
};

/** The model each download reads, by the address that reads it. */
const MODELOS_DESCARGA = {
  "POST /api/evento/export": EventoModel,
  "POST /api/poste/export": PosteModel,
  "POST /api/usuario/export": UsuarioModel,
} as const;

describe("every download answers a file, and never an envelope", () => {
  for (const entrada of DESCARGAS) {
    it(`${entrada}`, async () => {
      const ruta = entrada.split(" ")[1];
      // `findAll` is rejected for every listing model by the tripwire above,
      // because a listing that still used it would reach the production copy.
      // A download legitimately calls it, so it is opened here — for this one
      // model, inside this one test, and `beforeEach` shuts it again.
      vi.spyOn(MODELOS_DESCARGA[entrada as keyof typeof MODELOS_DESCARGA], "findAll")
        .mockResolvedValue([] as never);

      const res = await request(app).post(ruta).query({ format: "csv" }).set("Cookie", COOKIE).set(DEL_FRONTEND);

      expect(res.status, `${ruta} contestó ${res.status}`).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-type"]).not.toContain("application/json");
      // The name has to survive, accents included, or every file is called
      // "download" — both forms, as `app.ts` exposes the header through CORS.
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="/);
      expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''");
      // A register of a company's assets, leaving the system as a file.
      expect(res.headers["cache-control"]).toBe("no-store");
      // The envelope is what this must NOT be.
      expect(res.text.startsWith("{")).toBe(false);
    });
  }

  it("writes one line in the bitácora for each, and the directory one louder", async () => {
    for (const [entrada, modelo] of Object.entries(MODELOS_DESCARGA)) {
      vi.spyOn(modelo, "findAll").mockResolvedValue([] as never);
      await request(app).post(entrada.split(" ")[1]).query({ format: "csv" }).set("Cookie", COOKIE).set(DEL_FRONTEND);
    }
    const acciones = bitacoraCreate.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acciones.sort()).toEqual(["EXPORT_EVENTO", "EXPORT_POSTE", "EXPORT_USUARIO"]);

    // Not decoration. The moment the staff directory — names, telephones, birth
    // dates — stops being something behind a session and becomes a file that
    // can be forwarded is worth more than an `info` line among thousands.
    const severidades = new Map(
      bitacoraCreate.mock.calls.map((c) => {
        const fila = c[0] as { action: string; severity: string };
        return [fila.action, fila.severity];
      }),
    );
    expect(severidades.get("EXPORT_USUARIO")).toBe("warning");
    expect(severidades.get("EXPORT_POSTE")).toBe("info");
  });


  it("refuses a download that cannot show it came from our own frontend", async () => {
    const espia = vi.spyOn(PosteModel, "findAll").mockResolvedValue([] as never);

    // No `Origin`, no client header: what a `<form>` or an `<img>` on somebody
    // else's page can produce, carrying the victim's cookie because `SameSite=Lax`
    // lets a top-level navigation take it.
    const sinNada = await request(app).post("/api/poste/export").query({ format: "csv" }).set("Cookie", COOKIE);
    expect(sinNada.status).toBe(403);

    // An origin that is not ours: a cross-site `fetch` naming itself honestly.
    const otroOrigen = await request(app).post("/api/poste/export").query({ format: "csv" })
      .set("Cookie", COOKIE).set("Origin", "https://evil-osefi.net").set(CSRF_CLIENT_HEADER, "web");
    expect(otroOrigen.status).toBe(403);

    // 🔴 The reason this test exists rather than the status codes above. These
    // three routes were made POSTs so that this barrier would cover them: as
    // GETs they would be outside it, and a page anywhere could make an employee's
    // browser assemble twenty spreadsheets from twenty `<img>` tags. Nothing is
    // read by the attacker — CORS sees to that — it is the server's memory and
    // its one export slot being spent on somebody else's say-so.
    expect(espia, "la exportación corrió pese al 403").not.toHaveBeenCalled();
  });

  it("refuses a format it does not know, and builds nothing", async () => {
    const espia = vi.spyOn(PosteModel, "findAll").mockResolvedValue([] as never);
    const res = await request(app).post("/api/poste/export").query({ format: "docx" }).set("Cookie", COOKIE).set(DEL_FRONTEND);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Formato no v\u00e1lido/);
    // Before the query, not after: an unknown format that still read the table
    // would be a full scan anyone could ask for by typing a wrong word.
    expect(espia).not.toHaveBeenCalled();
  });

  it("refuses a filter column the listing does not have, with the same sentence", async () => {
    const espia = vi.spyOn(PosteModel, "findAll").mockResolvedValue([] as never);
    const res = await request(app).post("/api/poste/export")
      .query({ format: "csv", filterColumn: "deletedAt", filterValue: "x" })
      .set("Cookie", COOKIE).set(DEL_FRONTEND);

    expect(res.status).toBe(400);
    // The very sentence `GET /api/poste/` answers, because it is the very
    // function: one filter builder for the list and the file it exports.
    expect(res.body.message).toContain("No se puede filtrar la lista de postes");
    expect(espia).not.toHaveBeenCalled();
  });
});

// ─── What a download actually contains ──────────────────────────────────────

/**
 * A row shaped like the one the export query returns.
 *
 * `toJSON` because that is what the handlers call — Sequelize hands back model
 * instances, not plain objects, and a fixture of plain objects would have made
 * the handler throw `fila.toJSON is not a function` while these tests, running
 * with an empty list, stayed green. Which is exactly what they did until an
 * audit pointed out that every one of them exercised zero rows.
 *
 * Each fixture deliberately carries **more than the file may show**: the author,
 * the recovery address, the lock state. The projection is the security control
 * of these three endpoints, and a test that feeds it only what it is allowed to
 * emit cannot tell a whitelist from no list at all.
 */
const comoFila = (datos: Record<string, unknown>) => ({ toJSON: () => datos });

const CSV = { format: "csv" } as const;
const pedir = (ruta: string) =>
  request(app).post(ruta).query(CSV).set("Cookie", COOKIE).set(DEL_FRONTEND);

describe("what a download actually contains", () => {
  it("el fichero de postes: las ocho columnas, y ni una palabra del autor", async () => {
    vi.spyOn(PosteModel, "findAll").mockResolvedValue([comoFila({
      id: 40, name: "P-001", lat: -16.5, lng: -68.1, date: new Date("2026-03-01T12:00:00Z"),
      material: { name: "Madera" },
      propietario: { name: "Osefi" },
      ciudadA: { name: "Sucre" },
      ciudadB: { name: "Potosí" },
      // Joined for `sortBy=usuario`, and must not reach a single cell.
      usuario: { id: 7, name: "Isaias", lastname: "Salas" },
      id_usuario: 7,
    })] as never);

    const res = await pedir("/api/poste/export");
    expect(res.status).toBe(200);
    const [cabecera, fila] = res.text.slice(1).split("\r\n");

    expect(cabecera).toBe("#,Nombre,Tramo,Material,Propietario,Lat,Lng,Fecha en campo");
    expect(fila).toBe("1,P-001,Sucre > Potosí,Madera,Osefi,-16.5,-68.1,01/03/2026");
    // 🔴 Dicho por separado del `toBe` de arriba, porque un `toBe` que cambie
    // por cualquier motivo se arregla mirando la línea nueva; esto no se puede
    // arreglar sin verlo. §6 cerró el expediente de actividad de un empleado y
    // una hoja de cálculo con «quién registró cada uno de 1.687 postes» lo
    // reabre, ordenable y contable, en manos del rol Cliente.
    expect(res.text).not.toContain("Isaias");
    expect(res.text).not.toContain("Salas");
  });

  it("el fichero de incidencias: gravedad en dos columnas, última revisión y el color", async () => {
    vi.spyOn(EventoModel, "findAll").mockResolvedValue([comoFila({
      id: 5, description: "Cable suelto", state: false, priority: true,
      poste: {
        name: "P-001", lat: -16.5, lng: -68.1,
        ciudadA: { name: "Sucre" }, ciudadB: { name: "Potosí" },
        propietario: { name: "Osefi" },
      },
      // Desordenadas a propósito: la columna dice **la última**, no la primera.
      revisions: [{ date: "2026-05-02T12:00:00Z" }, { date: "2026-03-01T12:00:00Z" }],
      // Dos niveles: la columna dice **el peor**, que es el número más bajo.
      eventoObs: [{ ob: { name: "Fricción", criticality: 6 } }, { ob: { name: "Vano bajo", criticality: 5 } }],
      usuario: { id: 7, name: "Isaias", lastname: "Salas" },
    })] as never);

    const res = await pedir("/api/evento/export");
    expect(res.status).toBe(200);
    const [cabecera, fila] = res.text.slice(1).split("\r\n");

    expect(cabecera).toBe(
      "#,Poste,Tramo,Propietario,Lat,Lng,Descripción,Resuelto,Gravedad,Clasificación,Prioritario,Última revisión,Observaciones",
    );
    expect(fila).toBe(
      '1,P-001,Sucre > Potosí,Osefi,-16.5,-68.1,Cable suelto,No,5,Vano bajo,Sí,02/05/2026,"Fricción, Vano bajo"',
    );
    expect(res.text).not.toContain("Isaias");
  });


  it("corta al undécimo fichero del minuto, y lo dice", async () => {
    // 🔴 Sin cubo, estas tres rutas son tres formas de mantener ocupada la
    // única plaza del proceso en bucle — y de dejar al generador de informes
    // inservible sin gastar un solo punto de **su** presupuesto, porque hasta
    // este arco el cubo vivía dentro de su router.
    vi.spyOn(PosteModel, "findAll").mockResolvedValue([] as never);

    const codigos: number[] = [];
    for (let i = 0; i < 11; i++) {
      codigos.push((await pedir("/api/poste/export")).status);
    }

    expect(codigos.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(codigos[10]).toBe(429);
  });

  it("el fichero de usuarios: siete columnas, y ninguna de las diez que el listado manda", async () => {
    vi.spyOn(UsuarioModel, "findAll").mockResolvedValue([comoFila({
      id: 7, name: "Isaias", lastname: "Salas", user: "isaias",
      phone: "+59170000000",
      birthday: new Date("1990-07-15T12:00:00Z"),
      createdAt: new Date("2026-01-05T12:00:00Z"),
      rol: { name: "Administrador" },
      // Todo esto viaja hoy en cada fila de `GET /api/usuario/`, que proyecta
      // `exclude: ["pass"]` — una lista negra de un campo. En la pantalla
      // alimenta las insignias de bloqueo; en una hoja de cálculo que se
      // reenvía es la dirección de recuperación de cada cuenta y **qué cuentas
      // pueden entrar hoy sin segundo factor y hasta cuándo**.
      email: "isaias@donefy.io",
      email_verified_at: new Date("2026-01-06T12:00:00Z"),
      mfa_grace_until: new Date("2026-12-01T12:00:00Z"),
      locked_until: null,
      failed_attempts: 3,
      pass_changed_at: new Date("2026-02-01T12:00:00Z"),
    })] as never);

    const res = await pedir("/api/usuario/export");
    expect(res.status).toBe(200);
    const [cabecera, fila] = res.text.slice(1).split("\r\n");

    expect(cabecera).toBe("#,Nombre,Apellido,Usuario,Teléfono,Rol,Nacimiento,Registrado");
    // El teléfono, entrecomillado y con apóstrofo: `+591…` es la única forma de
    // escribir un número boliviano y Excel lo lee como fórmula. El directorio
    // llevaba años saliendo con esa columna rota.
    expect(fila).toBe('1,Isaias,Salas,isaias,"\'+59170000000",Administrador,15/07/1990,05/01/2026');

    // Lo que estas seis líneas sujetan es **la lista de columnas**, no la
    // proyección: el fichero sólo escribe lo que `COLUMNAS_USUARIO` declara, así
    // que estos campos no llegarían a una celda ni pidiéndolos. Medido con una
    // mutación — cambiar la proyección por la del listado deja estas aserciones
    // en verde — y dicho aquí porque el comentario anterior afirmaba lo
    // contrario, que es justo la clase de test que parece cubrir algo y no lo
    // cubre. La proyección se sujeta abajo, por separado.
    for (const prohibido of ["isaias@donefy.io", "mfa_grace", "locked_until", "failed_attempts", "pass_changed"]) {
      expect(res.text, `${prohibido} llegó al fichero`).not.toContain(prohibido);
    }
    // Y las fechas de esos campos, que no llevan su nombre encima.
    expect(res.text).not.toContain("01/12/2026");
  });

  it("no le pide a la base de datos ni un campo que el fichero no muestre", async () => {
    // 🔴 La otra mitad, y la que de verdad es una lista blanca. `getUsuario`
    // proyecta `exclude: ["pass"]` — una lista negra de un campo — y con ella
    // cada fila arrastra el correo de recuperación, el estado de bloqueo y hasta
    // cuándo cada cuenta puede entrar sin segundo factor. Reutilizar esa
    // proyección aquí no cambiaría el fichero, porque las columnas mandan; lo
    // que cambiaría es que esos datos existirían en memoria dentro del proceso
    // que construye un fichero para mandar por correo. Una capa no sustituye a
    // la otra: la de arriba dice qué se escribe, ésta dice qué se lee.
    const espia = vi.spyOn(UsuarioModel, "findAll").mockResolvedValue([] as never);
    await pedir("/api/usuario/export");

    const opciones = espia.mock.calls[0][0] as { attributes?: unknown };
    expect(
      opciones.attributes,
      "la exportación de usuarios volvió a una lista negra",
    ).toEqual(["id", "name", "lastname", "user", "phone", "birthday", "createdAt"]);
  });
});
