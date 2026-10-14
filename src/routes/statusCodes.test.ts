// Which status every write answers, and the ledger that keeps the list honest.
//
// **The problem this exists for.** Before it, `POST /api/adss/` could go back to
// answering `200` for a row it had just created and the whole suite stayed
// green: nine of the eleven creates, eight of the ten archives and eight of the
// ten restores had no test asserting their success status at all. A status code
// is a contract with the browser, and until this file it was a contract nothing
// checked. Two of the five tests that did exist asserted `not.toBe(403)`, which
// accepts 200, 201, 204 and 500 alike.
//
// Two halves, and they fail for different reasons:
//
//   - **The ledger.** Every write the app really mounts appears in `ESPERADO`
//     with the status it answers, and the answer is read out of the controller's
//     own source. A route added tomorrow and left out fails here; an entry left
//     behind after a route is deleted fails here too. That two-directional
//     comparison is what stops the list going stale — the mechanism
//     `routeGuards.test.ts` and `listShape.test.ts` already use — and it is what
//     the previous count of creates lacked: the spec said twelve for a fortnight
//     after one of them was deleted.
//   - **The wire.** A handful of real requests, because the source cannot say
//     what actually leaves the server. A `204` that carries a body, or a
//     `Content-Type`, or an `ETag`, is still a bug, and `res.sendStatus(204)`
//     produces the last of those three.
//
// Nothing here reaches Postgres, and in this environment that is not a nicety:
// the configured database is a copy of production. Every method the exercised
// handlers touch is spied; the models stay real, because several declare their
// associations at import time and `vi.mock` on one of them breaks the graph for
// every router `app.ts` loads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Application } from "express";
import { allowedOrigins, CSRF_CLIENT_HEADER } from "../config/security.js";

vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => ({}),
  can: async () => true,
  invalidatePermissions: vi.fn(),
}));

const here = dirname(fileURLToPath(import.meta.url));

// ─── The mounted table ────────────────────────────────────────────────────────

/**
 * The mounts, captured the way `listShape.test.ts` captures them.
 *
 * Express 5 compiles a path into closures over a pattern nothing exposes, so
 * the prefixes have to be recorded as `app.use` receives them, during the
 * import of `app.js` and not after. Every handler after the path, not just the
 * first: a router is routinely mounted behind its middleware.
 */
const montajes: { prefijo: string; router: unknown }[] = [];
const express = (await import("express")).default;
const useOriginal = express.application.use;
express.application.use = function (this: Application, ...args: unknown[]) {
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
  route?: {
    path: string;
    stack: { method?: string; handle: { name: string } }[];
  };
}

const ESCRITURAS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Every write the application really answers, as `METHOD /ruta`, with the name
 * of the controller function at the end of its chain.
 *
 * The last layer and not the first: everything before it is a gate, a budget or
 * a body parser. `makeHandler` keeps the name it was given (`routeGuards.test.ts`
 * depends on the same thing), so a wrapped controller is still identifiable.
 */
const escriturasMontadas = (): { clave: string; handler: string }[] => {
  const rutas = new Map<string, string>();
  for (const { prefijo, router } of montajes) {
    for (const capa of (router as { stack?: Capa[] }).stack ?? []) {
      if (!capa.route) continue;
      const ultimo = capa.route.stack[capa.route.stack.length - 1];
      // `route.stack` holds one layer **per handler**, not per method, so
      // mapping it straight to methods counts a route once for every gate and
      // budget in front of it: 211 entries for 85 routes, and 211 `it()` blocks
      // of which most were duplicates. Deduplicating by the route's own key is
      // also what makes the anti-vacuity bound below mean what it says.
      for (const metodo of new Set(capa.route.stack.map((c) => c.method).filter(Boolean))) {
        const verbo = (metodo as string).toUpperCase();
        if (!ESCRITURAS.includes(verbo)) continue;
        rutas.set(`${verbo} ${prefijo}${capa.route.path}`, ultimo.handle.name);
      }
    }
  }
  return [...rutas].map(([clave, handler]) => ({ clave, handler }));
};

// ─── What each controller answers, read out of its own source ─────────────────

/** Which names are exported from more than one controller file. */
const repetidos = new Set<string>();

/** Every exported function in `src/controllers`, by name, as text. */
const cuerposDeControlador = (): Map<string, { fichero: string; texto: string }> => {
  const cuerpos = new Map<string, { fichero: string; texto: string }>();
  const dir = join(here, "..", "controllers");
  for (const fichero of readdirSync(dir)) {
    if (!fichero.endsWith(".ts") || fichero.endsWith(".test.ts")) continue;
    const lineas = readFileSync(join(dir, fichero), "utf8").split("\n");
    const marcas: { desde: number; nombre: string }[] = [];
    lineas.forEach((linea, i) => {
      const m = /^export (?:const|async function|function) (\w+)/.exec(linea);
      if (m) marcas.push({ desde: i, nombre: m[1] });
    });
    marcas.forEach((marca, k) => {
      const hasta = k + 1 < marcas.length ? marcas[k + 1].desde : lineas.length;
      // The map is keyed by bare name across every file, so a name exported
      // twice resolves to whichever file `readdirSync` returned last — and the
      // per-route assertion would then report on a handler that is not on that
      // route, with no diagnostic at all. Four names collide today, all of them
      // string constants; the test below is what stops the day a handler joins
      // them.
      if (cuerpos.has(marca.nombre)) repetidos.add(marca.nombre);
      cuerpos.set(marca.nombre, { fichero, texto: lineas.slice(marca.desde, hasta).join("\n") });
    });
  }
  return cuerpos;
};

/**
 * The 2xx a handler writes, or 200 when it writes none.
 *
 * `res.json(x)` with no `status` call before it answers 200, which is Express's
 * default, and the four webauthn handlers that end in a bare `res.json(...)`
 * really do rely on it. It is a fall-through and not a guess **for a handler
 * that answers out of its own body** — and one family does not: the three
 * `/export` routes answer through `responderFichero` in `src/exports/tabla.ts`,
 * which is why that file gets an assertion of its own below.
 *
 * That reading the first 2xx is reading the only one is re-measured by `never
 * writes two different 2xx` rather than asserted here. What that measurement
 * covers is every export marker this scanner finds in `src/controllers` —
 * around 180, of which some forty are string constants rather than functions.
 */
const dosXX = (texto: string): number[] => {
  const encontrados = new Set<number>();
  for (const m of texto.matchAll(/res\.status\((\d{3})\)|res\.sendStatus\((\d{3})\)/g)) {
    const codigo = Number(m[1] ?? m[2]);
    if (codigo >= 200 && codigo < 300) encontrados.add(codigo);
  }
  return [...encontrados];
};

// ─── The ledger ───────────────────────────────────────────────────────────────

/**
 * The status every write answers on success.
 *
 * **`201` when the response represents a row that did not exist**: the eleven
 * `create*`, the two the report generator saves, the upload, and the passkey
 * registration that was already correct. `POST /:id/resolve` is deliberately
 * not here even though it inserts a `solucions` row — what it answers carries
 * nothing of that row, and a `201` whose body is empty tells the caller about a
 * resource it cannot then read.
 *
 * **`204` where the write reports nothing**: the ten archives, the ten
 * restores, the account unlock, the role assignment, the file delete, and
 * resolve/reopen. That last
 * pair is a decision of Isaias's on 2026-09-05 and it resolves a contradiction
 * the spec carried: §3.5 said they stay `200` (true, in the sense that they are
 * not creations) while §9's rule said every empty write answers `204`. They
 * answer nothing, so they answer `204`.
 *
 * **`200` for everything else**, including three writes that archive and are
 * still `200` on purpose, because the number they return is the only output
 * their screen has: the two file cleanups, and the report generator's own
 * delete, which answers a sentence its client is typed to receive.
 */
const ESPERADO: Record<string, 200 | 201 | 204> = {
  // ── 201: a row that did not exist ──
  "POST /api/adss/": 201,
  "POST /api/auth/webauthn/register/verify": 201,
  "POST /api/ciudad/": 201,
  "POST /api/evento/": 201,
  "POST /api/generator/reportes": 201,
  "POST /api/generator/reportes/:id/duplicate": 201,
  "POST /api/generator/schedules/": 201,
  "POST /api/material/": 201,
  "POST /api/obs/": 201,
  "POST /api/poste/": 201,
  "POST /api/propietario/": 201,
  "POST /api/revision/": 201,
  "POST /api/rol/": 201,
  "POST /api/tipo-obs/": 201,
  "POST /api/tramo/": 201,
  "POST /api/files/": 201,
  "POST /api/usuario/": 201,

  // ── 204: the write reports nothing ──
  "POST /api/unsubscribe/": 204,
  "DELETE /api/generator/schedules/:id": 204,
  "DELETE /api/adss/:id": 204,
  "DELETE /api/ciudad/:id": 204,
  "DELETE /api/evento/:id": 204,
  "DELETE /api/files/:name": 204,
  "DELETE /api/material/:id": 204,
  "DELETE /api/obs/:id": 204,
  "DELETE /api/poste/:id": 204,
  "DELETE /api/propietario/:id": 204,
  "DELETE /api/rol/:id": 204,
  "DELETE /api/tipo-obs/:id": 204,
  "DELETE /api/tramo/:id": 204,
  "DELETE /api/usuario/:id": 204,
  "PATCH /api/adss/:id/restore": 204,
  "PATCH /api/ciudad/:id/restore": 204,
  "PATCH /api/evento/:id/restore": 204,
  "PATCH /api/material/:id/restore": 204,
  "PATCH /api/obs/:id/restore": 204,
  "PATCH /api/poste/:id/restore": 204,
  "PATCH /api/propietario/:id/restore": 204,
  "PATCH /api/rol/:id/restore": 204,
  "PATCH /api/tipo-obs/:id/restore": 204,
  "PATCH /api/tramo/:id/restore": 204,
  "PATCH /api/usuario/:id/restore": 204,
  "PATCH /api/usuario/:id/desbloquear": 204,
  // El sub-recurso del rol, y `204` por lo mismo que su vecino de arriba: lo
  // único que escribe es el número que el que llama acaba de mandar, así que no
  // hay nada que devolverle.
  "PUT /api/usuario/:id/rol": 204,
  "POST /api/evento/:id/reopen": 204,
  "POST /api/evento/:id/resolve": 204,

  // ── 200: an answer with something in it ──
  "DELETE /api/auth/sessions/:id": 200,
  "DELETE /api/auth/totp/": 200,
  "DELETE /api/auth/webauthn/credentials/:id": 200,
  "DELETE /api/files/broken-refs": 200,
  "DELETE /api/files/orphans": 200,
  "DELETE /api/generator/reportes/:id": 200,
  "POST /api/auth/email/send": 200,
  "POST /api/auth/email/verify": 200,
  "POST /api/auth/login": 200,
  "POST /api/auth/logout": 200,
  "POST /api/auth/logout-all": 200,
  "POST /api/auth/mfa/email-code": 200,
  "POST /api/auth/mfa/verify": 200,
  "POST /api/auth/password/forgot": 200,
  "POST /api/auth/password/reset": 200,
  // What the unsubscribe page shows before the button: a read with a body,
  // because the token must not travel in an address.
  "POST /api/unsubscribe/lookup": 200,
  "POST /api/auth/recovery-codes/": 200,
  "POST /api/auth/stepup": 200,
  "POST /api/auth/totp/confirm": 200,
  "POST /api/auth/totp/setup": 200,
  "POST /api/auth/webauthn/login/options": 200,
  "POST /api/auth/webauthn/login/verify": 200,
  "POST /api/auth/webauthn/passwordless/options": 200,
  "POST /api/auth/webauthn/passwordless/verify": 200,
  "POST /api/auth/webauthn/register/options": 200,
  "POST /api/evento/export": 200,
  "POST /api/generator/query": 200,
  // 200 y no 201: un POST que no crea nada. Es una lectura con cuerpo, igual
  // que la de arriba, y contesta 200 también cuando NO hay ruta — «no hay
  // trazado» es una respuesta correcta a «¿hay trazado?», y las cuatro
  // pantallas dibujan entonces la línea recta. El motivo viaja en el cuerpo.
  "POST /api/ruta/query": 200,
  "POST /api/generator/count": 200,
  "POST /api/generator/export": 200,
  // "Send it now" answers with what happened: sent, empty, too large, failed.
  "POST /api/generator/schedules/:id/run": 200,
  "POST /api/login/": 200,
  "POST /api/poste/export": 200,
  "POST /api/usuario/:id/mfa/reset": 200,
  "POST /api/usuario/export": 200,
  "PUT /api/adss/:id": 200,
  "PUT /api/ciudad/:id": 200,
  "PUT /api/evento/:id": 200,
  "PUT /api/generator/reportes/:id": 200,
  "PUT /api/generator/schedules/:id": 200,
  "PUT /api/material/:id": 200,
  "PUT /api/obs/:id": 200,
  "PUT /api/permiso/:id_rol": 200,
  "PUT /api/poste/:id": 200,
  "PUT /api/propietario/:id": 200,
  "PUT /api/rol/:id": 200,
  "PUT /api/tipo-obs/:id": 200,
  "PUT /api/tramo/:id": 200,
  "PUT /api/usuario/:id": 200,
  "PUT /api/usuario/username/:id": 200,
  "PUT /api/usuario/userpass/:id": 200,
};

describe("the ledger of every write", () => {
  const montadas = escriturasMontadas();
  const cuerpos = cuerposDeControlador();

  it("was read off the app, not guessed", () => {
    // Anti-vacuity, and not a formality: an empty capture satisfies both
    // directions of the comparison below and every per-route assertion after
    // it. Reading the router is exactly what a major version bump breaks.
    expect(montadas.length, "no se leyó ninguna escritura del router").toBeGreaterThan(80);
    expect(cuerpos.size, "no se leyó ningún controlador").toBeGreaterThan(150);
  });

  it("classifies every mounted write, and every classified write exists", () => {
    const claves = new Set(montadas.map((r) => r.clave));
    const sinClasificar = [...claves].filter((c) => !(c in ESPERADO));
    const fantasmas = Object.keys(ESPERADO).filter((c) => !claves.has(c));

    expect(
      sinClasificar,
      `estas escrituras no dicen qué código contestan: añádelas a ESPERADO:\n  ${sinClasificar.join("\n  ")}`,
    ).toEqual([]);
    expect(
      fantasmas,
      `estas entradas de ESPERADO ya no son rutas: quítalas:\n  ${fantasmas.join("\n  ")}`,
    ).toEqual([]);
  });

  it("holds the count of each code, so a table filled with 200 cannot pass", () => {
    const cuenta = (codigo: number) => Object.values(ESPERADO).filter((c) => c === codigo).length;

    // Fifteen and twenty-four were the numbers §3.5 predicted, recounted on the
    // day C4 was done; the second is twenty-five since `PUT /api/usuario/:id/rol`
    // exists. They live in this assertion and nowhere else: five figures of the
    // spec went stale in twenty-four hours because several sessions share the
    // tree.
    // Sixteen, twenty-seven and fifty since the scheduled reports: creating a
    // schedule (201); removing one and unsubscribing from one (204); changing
    // one, sending it now, and asking what an unsubscribe link would stop (200).
    // And one more of each since `/api/tramo`: its creation (201), its archive and
    // its restore (204), and its edit (200).
    expect(cuenta(201), "las altas que contestan 201").toBe(17);
    expect(cuenta(204), "las escrituras que no contestan nada").toBe(29);
    // 47 desde que `POST /api/ruta/query` existe: una lectura con cuerpo, que
    // no crea ni archiva nada. Sube por el mismo motivo que subiría cualquier
    // otra — este número se recuenta, no se estima. 51 con `PUT /api/tramo/:id`.
    expect(cuenta(200), "el resto de las escrituras").toBe(51);
  });

  it("never writes two different 2xx in one handler", () => {
    // The premise `dosXX` rests on. If a handler ever answers 200 down one path
    // and 201 down another, reading "the first" stops meaning anything and this
    // file has to grow a way to say which is which — better told here than by
    // a per-route assertion that quietly reads the wrong one.
    const ambiguos = [...cuerpos.entries()]
      .filter(([, { texto }]) => dosXX(texto).length > 1)
      .map(([nombre, { fichero, texto }]) => `${fichero} ${nombre}: ${dosXX(texto).join(", ")}`);

    expect(ambiguos, `estos manejadores contestan más de un 2xx:\n  ${ambiguos.join("\n  ")}`).toEqual([]);
  });

  for (const { clave, handler } of montadas) {
    const esperado = ESPERADO[clave];
    if (esperado === undefined) continue; // the ledger above already fails for this
    it(`${clave} contesta ${esperado}`, () => {
      const cuerpo = cuerpos.get(handler);
      expect(cuerpo, `no se encontró el controlador \`${handler}\` de ${clave}`).toBeDefined();
      const codigos = dosXX(cuerpo!.texto);
      // No 2xx written at all means `res.json(...)` — Express's own 200.
      expect(codigos.length === 0 ? 200 : codigos[0], `${cuerpo!.fichero} → ${handler}`).toBe(esperado);
    });
  }

  it("no deja ningún `sendStatus` de éxito en un controlador", () => {
    // The per-route assertions pin today's routes. This is what stops the
    // pattern coming back one controller at a time — and it covers **every**
    // 2xx, not just the 200 it started with, because the two failures differ
    // and both are silent:
    //
    //   - `sendStatus(200)` sends the word "OK" as `text/plain` from an API
    //     that only speaks JSON.
    //   - `sendStatus(204)` satisfies every status assertion in this file and
    //     still ships an `ETag` computed over the string "No Content" — the
    //     same validator on all twenty-four archives — because Express sets the
    //     ETag before it strips the body for a 204 and does not strip the
    //     header.
    //
    // The second is why the first version of this test certified nothing:
    // looking only for the literal `sendStatus(200)`, rewriting any of the
    // twenty-four back to `sendStatus(204)` left it green.
    const dir = join(here, "..", "controllers");
    const culpables: string[] = [];
    for (const fichero of readdirSync(dir)) {
      if (!fichero.endsWith(".ts") || fichero.endsWith(".test.ts")) continue;
      readFileSync(join(dir, fichero), "utf8").split("\n").forEach((linea, i) => {
        if (/sendStatus\(\s*2\d\d\s*\)/.test(linea)) culpables.push(`${fichero}:${i + 1}`);
      });
    }
    expect(culpables, `una escritura de éxito usa sendStatus:\n  ${culpables.join("\n  ")}`).toEqual([]);
  });

  it("no usa el mismo nombre de manejador en dos ficheros", () => {
    // The scanner keys bodies by bare function name across all of
    // `src/controllers`. Two handlers sharing a name would make a per-route
    // assertion read whichever file came last, and say nothing about it.
    const manejadores = new Set(montadas.map((r) => r.handler));
    const ambiguos = [...repetidos].filter((n) => manejadores.has(n));
    expect(
      ambiguos,
      `estos nombres se exportan desde más de un controlador y una ruta los usa:\n  ${ambiguos.join("\n  ")}`,
    ).toEqual([]);
  });

  it("fija el 200 de las tres descargas, que no lo escriben en su controlador", () => {
    // `exportarPostes`, `exportarEventos` and `exportarUsuarios` end in
    // `responderFichero`, so their bodies hold no 2xx at all and the rule above
    // files them as 200 without having read anything. This reads it.
    const tabla = readFileSync(join(here, "..", "exports", "tabla.ts"), "utf8");
    const codigos = [...tabla.matchAll(/res\.status\((\d{3})\)/g)].map((m) => Number(m[1]));
    expect(
      codigos.filter((c) => c >= 200 && c < 300),
      "responderFichero debe contestar 200",
    ).toEqual([200]);
  });

  it("keeps the two file cleanups answering the number they clean", () => {
    // The named exception to the `204` rule, and the reason it is one: the
    // count is the only output the Archivos screen has. A `204` cannot carry a
    // body, and the screen would say "undefined referencias limpiadas".
    for (const nombre of ["deleteOrphanFiles", "clearBrokenImageRefs"]) {
      const texto = cuerpos.get(nombre)?.texto ?? "";
      expect(texto, `no se encontró ${nombre}`).not.toBe("");
      expect(dosXX(texto), `${nombre} debe contestar 200`).toEqual([200]);
      expect(/res\s*\n?\s*\.?\s*status\(200\)\s*\.json\(/.test(texto), `${nombre} debe contestar con cuerpo`).toBe(true);
    }
  });
});

// ─── The wire ─────────────────────────────────────────────────────────────────

const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { AdssModel } = await import("../models/adss.model.js");
const { ObsModel } = await import("../models/obs.model.js");
const { BitacoraModel } = await import("../models/bitacora.model.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const bitacoraCreate = vi.spyOn(BitacoraModel, "create");
const adssCreate = vi.spyOn(AdssModel, "create");
const adssDestroy = vi.spyOn(AdssModel, "destroy");
const adssRestore = vi.spyOn(AdssModel, "restore");
const adssFindOne = vi.spyOn(AdssModel, "findOne");
const obsCreate = vi.spyOn(ObsModel, "create");

const YO = 7;
const COOKIE = `${SESSION_COOKIE_NAME}=un-token-opaco-de-treinta-y-dos-bytes`;

/**
 * The two headers `requireSameOrigin` wants on a write.
 *
 * The origin is read off `allowedOrigins` rather than written out, so it is the
 * one this environment is really configured with.
 */
const DEL_FRONTEND = {
  Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0],
  [CSRF_CLIENT_HEADER]: "web",
};

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
      image: null, pass_changed_at: new Date(Date.now() - 365 * 86_400_000),
    },
  } as never);
  // Tripwires, not conveniences: both would otherwise reach the configured
  // database, which is a copy of production.
  sesionUpdate.mockRejectedValue(new Error("touchSession corrió: esto habría escrito en la base de datos") as never);
  bitacoraCreate.mockResolvedValue({} as never);
});

describe("what actually leaves the server", () => {
  it("answers 201 with the row when a row is created", async () => {
    adssCreate.mockResolvedValue({ dataValues: { id: 42, name: "Ferretería nueva" } } as never);

    const res = await request(app)
      .post("/api/adss/")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ name: "Ferretería nueva" });

    expect(res.status).toBe(201);
    // The body matters as much as the number. `res.sendStatus(201)` would
    // satisfy the status assertion and break `PosteSheet` and the incident
    // sheet, which both read the created row back.
    expect(res.body).toMatchObject({ dataValues: { id: 42 } });
  });

  it("answers 204 with nothing at all when a row is archived", async () => {
    adssDestroy.mockResolvedValue(1 as never);

    const res = await request(app).delete("/api/adss/42").set("Cookie", COOKIE).set(DEL_FRONTEND);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(res.headers["content-type"]).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
    // `res.sendStatus(204)` passes every assertion above and fails this one:
    // Express computes the ETag before it strips the body for a 204 and does
    // not strip the header, so every archive in the product would answer the
    // same validator, computed over the string "No Content". Measured against
    // the installed Express before this was written. `res.status(204).end()`
    // is what avoids it.
    expect(res.headers["etag"]).toBeUndefined();
  });

  it("answers 204 with nothing at all when a row is restored", async () => {
    adssRestore.mockResolvedValue(undefined as never);
    // The handler looks the row up among the archived before restoring it, so
    // that restoring nothing is a 404 and not a line in the audit log.
    adssFindOne.mockResolvedValue({ get: (campo: string) => (campo === "deletedAt" ? new Date() : 42) } as never);

    const res = await request(app).patch("/api/adss/42/restore").set("Cookie", COOKIE).set(DEL_FRONTEND);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(res.headers["etag"]).toBeUndefined();
  });

  it("tells the caller which field it got wrong instead of blaming the server", async () => {
    // The live defect this half of C4 fixes, driven through the whole stack
    // with a real Sequelize failure rather than a hand-made one: `obs.model.ts`
    // is the only model in the repo with a `validate:` block, and a criticality
    // of 12 breaks it. Before C4 this answered `500 "Ocurrió un error al
    // procesar la petición."` — the caller's own body, reported as a broken
    // server. Measured, on this route, before the change.
    obsCreate.mockImplementation(async (valores: unknown) => {
      const fila = ObsModel.build(valores as never);
      await fila.validate();
      return fila as never;
    });

    const res = await request(app)
      .post("/api/obs/")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ name: "Cable suelto", id_tipoObs: 1, criticality: 12 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("criticality");
    expect(res.body.message).not.toBe("Ocurrió un error al procesar la petición.");
  });

  it("still answers the neutral 500 when the failure is the server's", async () => {
    // The anti-vacuity half of the test above: a classifier that answered 400
    // for everything would satisfy it, and would also hand the browser the text
    // of whatever Postgres said. This is the line `errorShape.test.ts` guards
    // from the source side and this guards from the wire.
    obsCreate.mockRejectedValue(new Error("la conexión se cayó a mitad") as never);

    const res = await request(app)
      .post("/api/obs/")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ name: "Cable suelto", id_tipoObs: 1, criticality: 3 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Ocurrió un error al procesar la petición." });
  });
});
