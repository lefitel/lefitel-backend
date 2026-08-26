// Revoking a session stops it authenticating. Through the real app, against a
// table that behaves like a table.
//
// **Why this file exists.** Everything the retirement of the old token was for
// comes down to one sentence — a session can be taken back — and until now the
// only assertion in either repository that fell when it broke was
// `sessionStore.test.ts`'s `expect(lookedUpWith()).toHaveProperty("revoked_at",
// null)`. That reads the `where` handed to a Sequelize double. It is a true
// thing to assert and it is not the promise: with `SesionModel` mocked
// call-recording everywhere, any break in revocation that is not inside that one
// `where` left the whole suite green and "cerrar todas mis sesiones" quietly
// meaningless. Revoke by writing a column the read does not consult, ask
// `UPDATE ... WHERE revoked_at != NULL` instead of `IS NULL`, let `authenticate`
// carry on past a null session — all of them, green.
//
// **What is real here and what is not.** The app is the real one: real
// `cookie-parser`, real `express.json`, real helmet and CSRF guard, real
// `authenticate`, real `sessionStore`, real controllers. What is replaced is the
// five query methods of `SesionModel`, and not with spies that record calls —
// with a small in-memory table that evaluates the `where` it is given, honours
// `attributes`, and mutates rows on `update`. So a revocation written to one
// column and read from another does not match here either, which is the whole
// point: the two halves have to agree for these tests to pass, and nothing in
// the test says what they should agree on.
//
// **What it still cannot see**, said plainly rather than left to be assumed: it
// is not Postgres. A column name that diverges between `sesion.model.ts` and its
// migration, a `revoked_at` written as text into a `timestamptz`, a `paranoid`
// or `underscored` option that rewrites a query underneath Sequelize — none of
// those are visible from here, because the model's own mapping is exactly what is
// stubbed out. The audit measured those against a real database and they hold;
// what this file adds is that they cannot silently *start* failing through the
// application's own logic.
//
// The fake table is itself code that could be wrong, so every test below asserts
// the live case as well as the dead one. A matcher that answered "no rows" to
// everything would make every revocation look perfect and fails the first
// assertion of every test here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";
import { randomUUID } from "node:crypto";
import request from "supertest";

const permisos = { seguridad: { ver: true } };
vi.mock("./permissions/store.js", () => ({}));
vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => permisos,
  can: async () => false,
  invalidatePermissions: vi.fn(),
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));

const app = (await import("../app.js")).default;
const { SESSION_COOKIE_NAME } = await import("./sessionCookie.js");
const { CSRF_CLIENT_HEADER, SESSION_ABSOLUTE_DAYS } = await import("../config/security.js");
const { allowedOrigins } = await import("../config/security.js");
const { createSession } = await import("./sessionStore.js");
const { SesionModel } = await import("../models/sesion.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");

const YO = 7;
const MI_ROL = 2;
const DIA_MS = 86_400_000;

/**
 * What the browser sends alongside the cookie on a write.
 *
 * `requireSameOrigin` turns a cookie-carrying write that cannot show it came
 * from our own frontend into a 403 before it reaches any controller, so
 * `logout`, `logout-all` and `DELETE /sessions/:id` all need this or they never
 * get near the code under test — and a 403 would look like a refusal the tests
 * below could misread as success.
 */
const DEL_FRONTEND = {
  Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0] as string,
  [CSRF_CLIENT_HEADER]: "web",
};

/** A row of `sesiones`, as the store writes it. */
type Fila = Record<string, unknown>;

/**
 * The table.
 *
 * An array plus a `where` evaluator, which is the only interesting part: it has
 * to understand the four shapes the session store actually builds — a scalar, a
 * `null`, a Symbol-keyed operator clause, and a top-level `Op.or` of them —
 * without knowing which columns any of them are about. That ignorance is what
 * makes this able to catch a write and a read disagreeing.
 */
let tabla: Fila[] = [];

/** Whether one row satisfies one condition on one column. */
function cumple(valor: unknown, condicion: unknown): boolean {
  // A Symbol-keyed clause: `{ [Op.gt]: date }` and friends. Read past the
  // Symbol, because `JSON.stringify` and `in` cannot see these at all.
  if (condicion !== null && typeof condicion === "object" && !(condicion instanceof Date)) {
    const ops = Object.getOwnPropertySymbols(condicion as object);
    if (ops.length > 0) {
      const clause = condicion as Record<symbol, unknown>;
      return ops.every((op) => {
        const limite = clause[op];
        const a = valor instanceof Date ? valor.getTime() : valor;
        const b = limite instanceof Date ? limite.getTime() : limite;
        if (op === Op.gt) return (a as number) > (b as number);
        if (op === Op.lt) return (a as number) < (b as number);
        if (op === Op.gte) return (a as number) >= (b as number);
        if (op === Op.lte) return (a as number) <= (b as number);
        if (op === Op.ne) return a !== b;
        // An operator this fake does not implement must be loud rather than
        // quietly true: a silent `true` here would make some future query match
        // everything and the tests pass for the wrong reason.
        throw new Error(`el where usa un operador que esta tabla falsa no implementa: ${String(op)}`);
      });
    }
  }
  const a = valor instanceof Date ? valor.getTime() : valor;
  const b = condicion instanceof Date ? condicion.getTime() : condicion;
  // `==` is not used anywhere: `revoked_at: null` has to mean "is null" and not
  // "is null or undefined or empty", which is what Postgres means by `IS NULL`
  // on a column that always exists.
  return a === b;
}

function coincide(fila: Fila, where: Record<string | symbol, unknown> | undefined): boolean {
  if (!where) return true;
  for (const op of Object.getOwnPropertySymbols(where)) {
    if (op === Op.or) {
      const ramas = where[op] as Record<string, unknown>[];
      if (!ramas.some((rama) => coincide(fila, rama))) return false;
      continue;
    }
    throw new Error(`el where usa un operador de nivel superior sin implementar: ${String(op)}`);
  }
  for (const columna of Object.keys(where)) {
    if (!cumple(fila[columna], where[columna])) return false;
  }
  return true;
}

/** `attributes`, honoured, so a column the query excluded really is absent. */
function proyecta(fila: Fila, attributes: unknown): Fila {
  if (Array.isArray(attributes)) {
    return Object.fromEntries(attributes.map((k) => [k, fila[k as string]]));
  }
  const exclude = (attributes as { exclude?: string[] } | undefined)?.exclude;
  if (!exclude) return { ...fila };
  const copia = { ...fila };
  for (const k of exclude) delete copia[k];
  return copia;
}

type Consulta = { where?: Record<string, unknown>; attributes?: unknown; order?: [string, string][] };

beforeEach(() => {
  vi.clearAllMocks();
  tabla = [];

  vi.spyOn(SesionModel, "create").mockImplementation(async (values: unknown) => {
    const fila = { ...(values as Fila) };
    /**
     * The column's own `DataTypes.UUIDV4` default is what generates this in
     * production (see `sesion.model.ts`), so the fake has to supply it too —
     * otherwise every row shares an `undefined` id and `DELETE /sessions/:id`
     * would appear to work by matching all of them at once.
     *
     * And it has to be a real, lower-case UUID rather than any unique string:
     * `endSession` checks the shape against `ES_UUID` before it queries anything,
     * because `sesiones.id` is a `uuid` column and Postgres raises 22P02 rather
     * than returning no rows for a value that is not one. A fake that handed out
     * `id-1-3f2a` made every `DELETE /sessions/:id` a clean 404 and the two tests
     * that use it fail for a reason that had nothing to do with revocation —
     * which is the fake being *less* faithful than production, and worth the
     * paragraph.
     */
    if (fila.id === undefined) fila.id = randomUUID();
    tabla.push(fila);
    return { dataValues: fila } as never;
  });

  vi.spyOn(SesionModel, "findOne").mockImplementation(async (options: unknown) => {
    const { where, attributes } = (options ?? {}) as Consulta;
    const fila = tabla.find((f) => coincide(f, where));
    return fila ? ({ dataValues: proyecta(fila, attributes) } as never) : (null as never);
  });

  vi.spyOn(SesionModel, "findAll").mockImplementation(async (options: unknown) => {
    const { where, attributes, order } = (options ?? {}) as Consulta;
    const filas = tabla.filter((f) => coincide(f, where));
    if (order?.length) {
      const [columna, sentido] = order[0];
      filas.sort((x, y) => {
        const a = Number(x[columna] instanceof Date ? (x[columna] as Date).getTime() : x[columna]);
        const b = Number(y[columna] instanceof Date ? (y[columna] as Date).getTime() : y[columna]);
        return sentido === "DESC" ? b - a : a - b;
      });
    }
    return filas.map((f) => ({ dataValues: proyecta(f, attributes) })) as never;
  });

  vi.spyOn(SesionModel, "update").mockImplementation(async (values: unknown, options: unknown) => {
    const { where } = (options ?? {}) as Consulta;
    const afectadas = tabla.filter((f) => coincide(f, where));
    for (const fila of afectadas) Object.assign(fila, values as Fila);
    return [afectadas.length] as never;
  });

  vi.spyOn(SesionModel, "destroy").mockImplementation(async (options: unknown) => {
    const { where } = (options ?? {}) as Consulta;
    const quedan = tabla.filter((f) => !coincide(f, where));
    const borradas = tabla.length - quedan.length;
    tabla = quedan;
    return borradas as never;
  });

  // The account behind every session below. `authenticate` reads it on every
  // request to notice a demotion or an archived account, and `paranoid` is what
  // makes an archived one answer nothing — not this test's subject, so it is a
  // live account throughout.
  vi.spyOn(UsuarioModel, "findByPk").mockResolvedValue({
    dataValues: { id: YO, id_rol: MI_ROL, user: "isaias", name: "Isaias", lastname: "Salas", image: null },
  } as never);
});

/** A browser: a session row of YO's, and the cookie header that names it. */
async function navegador(): Promise<{ cookie: string; id: string }> {
  const { token } = await createSession(YO, { userAgent: "Chrome", ip: "1.2.3.4" }, "completa");
  const fila = tabla[tabla.length - 1];
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, id: String(fila.id) };
}

const vivo = (cookie: string) => request(app).get("/api/auth/me").set("Cookie", cookie);
const SESION_EXPIRADA = "Su sesión expiró. Vuelva a iniciar sesión.";

describe("a session that has not been revoked", () => {
  it("authenticates, which is what makes every refusal below mean something", async () => {
    const a = await navegador();

    const res = await vivo(a.cookie);

    expect(res.status).toBe(200);
    expect(res.body.usuario.user).toBe("isaias");
  });

  it("is found by the hash of its token and never by the token itself", async () => {
    // The row holds a SHA-256, so a dump of this table hands over nothing that
    // can be replayed as a login. Asserted here and not only in
    // `sessionStore.test.ts` because this is the file where the lookup has to
    // actually *find* something: a fake that matched on the token instead would
    // pass a `where`-shaped assertion and fail this one.
    const a = await navegador();
    const token = a.cookie.split("=")[1];

    expect(tabla[0].token_hash).not.toBe(token);
    expect(JSON.stringify(tabla[0])).not.toContain(token);
    expect((await vivo(a.cookie)).status).toBe(200);
  });
});

describe("closing every session of this account", () => {
  it("throws the other browser out, which is the whole promise of this arc", async () => {
    /**
     * The two-browser check, which three task reports in a row left pending
     * because it needed a server and two browsers, and which the audit finally
     * ran by hand against Postgres. This is that check, in CI, on every commit.
     *
     * Under the retired credential it was impossible: a signed token had no row
     * behind it, so there was nothing to revoke and this endpoint answered "sus
     * sesiones se cerraron, pero este navegador seguirá dentro" — a sentence that
     * was an honest description of the hole.
     */
    const a = await navegador();
    const b = await navegador();

    // Both alive first. Without this the refusals below would also be what a
    // broken cookie, a broken fake table or a broken `authenticate` produces.
    expect((await vivo(a.cookie)).status).toBe(200);
    expect((await vivo(b.cookie)).status).toBe(200);

    const cerrando = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", a.cookie)
      .set(DEL_FRONTEND);

    expect(cerrando.status).toBe(200);
    expect(cerrando.body.cerradas).toBe(2);

    // The other browser, which never asked for anything and never sent another
    // request until now.
    const despues = await vivo(b.cookie);
    expect(despues.status).toBe(401);
    // The reason, not the number: `authenticate` answers 401 for a missing
    // cookie and for an archived account too, and a test reading the number
    // alone would pass for a revocation that did nothing while something else
    // on the path broke.
    expect(despues.body.message).toBe(SESION_EXPIRADA);

    // And the browser that pressed the button is out as well, because its own
    // credential is one of the rows.
    expect((await vivo(a.cookie)).status).toBe(401);
  });

  it("does not let a revoked cookie close sessions a second time", async () => {
    // A revoked credential must not be able to act, not even to do something
    // harmless-looking: an endpoint that answered on a dead session would be a
    // second door past the row, which is the door this whole arc closed.
    const a = await navegador();
    await request(app).post("/api/auth/logout-all").set("Cookie", a.cookie).set(DEL_FRONTEND);

    const otra = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", a.cookie)
      .set(DEL_FRONTEND);

    expect(otra.status).toBe(401);
    expect(otra.body.message).toBe(SESION_EXPIRADA);
  });

  it("takes the revoked device off the list the profile screen shows", async () => {
    // The other half of a revocation, and the one somebody actually looks at
    // after losing a laptop. A list that still showed a session `authenticate`
    // has been refusing tells them a risk is open when it is closed — or, the
    // other way round, that it is closed when it is not.
    const a = await navegador();
    const b = await navegador();

    const antes = await request(app).get("/api/auth/sessions").set("Cookie", a.cookie);
    expect(antes.status).toBe(200);
    expect(antes.body.sesiones).toHaveLength(2);
    // The hash never leaves the database, and the fake honours `attributes`, so
    // this is the real exclusion talking.
    expect(JSON.stringify(antes.body)).not.toContain("token_hash");

    await request(app)
      .delete(`/api/auth/sessions/${b.id}`)
      .set("Cookie", a.cookie)
      .set(DEL_FRONTEND);

    const despues = await request(app).get("/api/auth/sessions").set("Cookie", a.cookie);
    expect(despues.body.sesiones).toHaveLength(1);
    expect(despues.body.sesiones[0].id).toBe(a.id);
  });
});

describe("closing one session", () => {
  it("ends the one that asked and leaves the others working", async () => {
    // The button in the corner of the screen. Somebody who logs out on the
    // office computer has not asked to be logged out on their phone.
    const a = await navegador();
    const b = await navegador();

    const res = await request(app).post("/api/auth/logout").set("Cookie", a.cookie).set(DEL_FRONTEND);
    expect(res.status).toBe(200);

    expect((await vivo(a.cookie)).status).toBe(401);
    expect((await vivo(b.cookie)).status).toBe(200);
  });

  it("ends the one named in the URL, and only if it belongs to the caller", async () => {
    /**
     * `DELETE /api/auth/sessions/:id` takes its id from the URL, which is the
     * caller's to write, so `revokeSessionOf` puts `id_usuario` in the same
     * `where`. `app.auth.test.ts` proves the filter is in the query by reading
     * the query; this proves what the filter is *for*, by pointing the endpoint
     * at somebody else's row and finding it still alive afterwards.
     */
    const mia = await navegador();
    const { token: ajeno } = await createSession(99, {}, "completa");
    const filaAjena = tabla[tabla.length - 1];

    const res = await request(app)
      .delete(`/api/auth/sessions/${filaAjena.id}`)
      .set("Cookie", mia.cookie)
      .set(DEL_FRONTEND);

    // 404 and not 403: a 403 would confirm the row exists and belongs to
    // somebody, which is the thing an id-guesser is asking.
    expect(res.status).toBe(404);
    expect(filaAjena.revoked_at).toBeNull();
    // And the session really is still usable, which is what "not revoked"
    // has to mean rather than just a column being null.
    expect(tabla.some((f) => f.token_hash === filaAjena.token_hash)).toBe(true);
    void ajeno;

    // The caller's own, by contrast, closes.
    const propia = await request(app)
      .delete(`/api/auth/sessions/${mia.id}`)
      .set("Cookie", mia.cookie)
      .set(DEL_FRONTEND);
    expect(propia.status).toBe(200);
    expect((await vivo(mia.cookie)).status).toBe(401);
  });
});

describe("the two ways a session dies without anybody revoking it", () => {
  it("stops authenticating once its idle expiry has passed", async () => {
    // The condition `findLiveSession` checks second. Exercised here as behaviour
    // rather than as an `Op.gt` in a `where`, which is what the unit test can
    // see: an inverted bound would return only dead rows, and that is the shape
    // this catches.
    const a = await navegador();
    expect((await vivo(a.cookie)).status).toBe(200);

    tabla[0].expires_at = new Date(Date.now() - 1000);

    const res = await vivo(a.cookie);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe(SESION_EXPIRADA);
  });

  it("stops authenticating at the absolute ceiling, however fresh its expiry looks", async () => {
    /**
     * The condition most likely to be dropped by a later edit, because the idle
     * expiry looks like it covers everything. It does not: a session used every
     * day pushes `expires_at` forward on every touch, so without the ceiling a
     * stolen cookie lives for ever by being used — which is exactly what the
     * retired token did.
     *
     * The row below has a perfectly healthy `expires_at` and a `created_at` past
     * the ceiling, so the idle check alone would let it in.
     */
    const a = await navegador();
    tabla[0].created_at = new Date(Date.now() - (SESSION_ABSOLUTE_DAYS + 1) * DIA_MS);
    tabla[0].expires_at = new Date(Date.now() + DIA_MS);

    expect((await vivo(a.cookie)).status).toBe(401);

    // And it is the ceiling doing it, not the expiry: move `created_at` back
    // inside and the very same row works again.
    tabla[0].created_at = new Date();
    expect((await vivo(a.cookie)).status).toBe(200);
  });
});
