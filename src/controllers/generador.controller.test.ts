// Who may read, edit, archive and copy a saved report.
//
// Four hundred lines where every permission rule of the feature lives, and not
// one test reached them. One of these rules already broke once: the comment at
// `putReporte` records a bypass that let an administrator open a colleague's
// shared report, change it and save over their work with no notice. Nothing
// stopped that from coming back.
//
// The models are stubbed and `buildQuery` is not: validation at save time is
// part of what these handlers promise, and mocking it would test the mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findByPk = vi.fn();
const findAndCountAll = vi.fn();
const create = vi.fn();

vi.mock("../models/reporteVista.model.js", () => ({
  ReporteVistaModel: {
    findByPk: (...args: unknown[]) => findByPk(...args),
    findAndCountAll: (...args: unknown[]) => findAndCountAll(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: { name: "UsuarioModel" } }));
const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...args: unknown[]) => logAction(...args) }));

/**
 * The permission matrix, stubbed per test.
 *
 * These handlers used to decide with role numbers written into the source —
 * `ADMIN_ROLE = 1`, `STAFF_ROLES = [1, 2]` — and the tests repeated the numbers
 * back, so both agreed with each other and neither agreed with the matrix. Now
 * a test grants a capability and says which one, which is also the only way to
 * notice when a rule starts asking for a different one.
 */
const runReport = vi.fn();
vi.mock("../reportBuilder/execute.js", () => ({
  runReport: (...args: unknown[]) => runReport(...args),
  countReport: vi.fn(),
}));

const granted = new Set<string>();
vi.mock("../permissions/store.js", () => ({
  can: (role: number, modulo: string, accion: string) =>
    Promise.resolve(granted.has(`${role}:${modulo}.${accion}`)),
}));
const grant = (role: number, ...capabilities: string[]) => {
  for (const capability of capabilities) granted.add(`${role}:${capability}`);
};

const {
  getCatalogo, getReporte, getReportes, postConsulta, postReporte, putReporte, deleteReporte,
  postDuplicar,
} = await import("./generador.controller.js");

const ADMIN = 1;
const SUPERVISOR = 2;
const TECNICO = 3;

const AUTHOR = 7;
const SOMEBODY_ELSE = 99;

/** A configuration the builder actually accepts, so validation is exercised. */
const validConfig = { root: "evento", columns: [{ path: "id" }] };

function call(
  user: { id: number; id_rol: number } | undefined,
  {
    params = {},
    body = {},
    query = {},
  }: { params?: Record<string, unknown>; body?: unknown; query?: Record<string, unknown> } = {},
) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return {
    req: { user, params, body, query } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
    get payload() {
      return res.body;
    },
  };
}

/** A stored row, plus the spies that say whether it was written to. */
function storedReport(over: Record<string, unknown> = {}) {
  const row = {
    id: 3,
    name: "Reporte de Ana",
    description: null,
    config: validConfig,
    id_usuario: AUTHOR,
    visibility: "private",
    favorite: false,
    ...over,
  };
  const update = vi.fn();
  const destroy = vi.fn();
  return { row, update, destroy, model: { toJSON: () => row, update, destroy } };
}

beforeEach(() => {
  vi.clearAllMocks();
  granted.clear();
  runReport.mockResolvedValue({ columns: [], rows: [], total: 0, limit: 100, offset: 0 });
});

describe("reading a saved report", () => {
  it("keeps a private report away from everyone but its author", async () => {
    const stored = storedReport({ visibility: "private" });
    findByPk.mockResolvedValue(stored.model);

    const c = call({ id: SOMEBODY_ELSE, id_rol: SUPERVISOR }, { params: { id: "3" } });
    await getReporte(c.req, c.res);

    expect(c.status).toBe(403);
    expect(c.message).toMatch(/privado/i);
  });

  it("hands a private report to its author", async () => {
    findByPk.mockResolvedValue(storedReport({ visibility: "private" }).model);

    const c = call({ id: AUTHOR, id_rol: TECNICO }, { params: { id: "3" } });
    await getReporte(c.req, c.res);

    expect(c.status).toBe(200);
  });

  it("hands a shared report to anyone", async () => {
    findByPk.mockResolvedValue(storedReport({ visibility: "shared" }).model);

    const c = call({ id: SOMEBODY_ELSE, id_rol: TECNICO }, { params: { id: "3" } });
    await getReporte(c.req, c.res);

    expect(c.status).toBe(200);
  });

  it("says a missing report is missing rather than refusing it", async () => {
    findByPk.mockResolvedValue(null);

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id: "3" } });
    await getReporte(c.req, c.res);

    expect(c.status).toBe(404);
  });
});

describe("listing saved reports", () => {
  it("hands out author names only to whoever may see people", async () => {
    // The listing is the back door to the same personal data the catalog hides:
    // every shared report carries its author. What opens it is `seguridad.ver`,
    // the permission that guards the screen where users are administered — and
    // not a role number, which is what this used to ask and why a coordinator
    // received names that `GET /usuario` refused them.
    findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    grant(ADMIN, "seguridad.ver");

    await getReportes(call({ id: AUTHOR, id_rol: SUPERVISOR }).req, call(undefined).res);
    const forSupervisor = findAndCountAll.mock.calls[0][0] as {
      include: { attributes: string[] }[];
    };
    expect(forSupervisor.include[0].attributes).toEqual(["id"]);

    await getReportes(call({ id: AUTHOR, id_rol: ADMIN }).req, call(undefined).res);
    const forAdmin = findAndCountAll.mock.calls[1][0] as { include: { attributes: string[] }[] };
    expect(forAdmin.include[0].attributes).toContain("name");
  });

  it("asks for one page and says how many there are in total", async () => {
    // The endpoint had no limit: every report the caller can see, each carrying
    // its whole configuration, in one response that grows for as long as the
    // product is used. The total travels with the page so the client can say
    // what it is not showing — a cap nobody is told about reads as "that is
    // all there is".
    findAndCountAll.mockResolvedValue({ rows: [], count: 137 });

    const c = call({ id: AUTHOR, id_rol: ADMIN });
    await getReportes(c.req, c.res);

    const query = findAndCountAll.mock.calls[0][0] as { limit: number; offset: number };
    expect(query.limit).toBe(100);
    expect(query.offset).toBe(0);
    expect(c.payload).toMatchObject({ total: 137, limit: 100, offset: 0, rows: [] });
  });

  it("never lets a caller ask for more than one page holds", async () => {
    findAndCountAll.mockResolvedValue({ rows: [], count: 0 });

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { query: { limit: "100000", offset: "-5" } });
    await getReportes(c.req, c.res);

    const query = findAndCountAll.mock.calls[0][0] as { limit: number; offset: number };
    expect(query.limit).toBe(200);
    expect(query.offset).toBe(0);
  });

  it("does not publish the paths of fields it is hiding from the reader", async () => {
    // A shared report names the fields it was built from. Handed over verbatim,
    // it told a reader that `usuario.user` exists and what somebody filtered it
    // against — the same personal data the catalog refuses them, arriving as
    // metadata instead of as rows.
    const secreto = {
      root: "evento",
      columns: [{ path: "id" }, { path: "usuario.user" }],
      filters: { op: "and", conditions: [{ path: "usuario.user", operator: "eq", value: "isaias" }] },
    };
    findAndCountAll.mockResolvedValue({
      rows: [{ toJSON: () => ({ ...storedReport().row, config: secreto }) }],
      count: 1,
    });

    const c = call({ id: AUTHOR, id_rol: TECNICO });
    await getReportes(c.req, c.res);

    const listed = JSON.stringify(c.payload);
    expect(listed).not.toContain("usuario.user");
    expect(listed).not.toContain("isaias");
    // And the reader is told the report is not complete, rather than being
    // handed a quietly narrower one.
    expect((c.payload as { rows: { omitted: number }[] }).rows[0].omitted).toBe(2);
  });
});

describe("editing a saved report", () => {
  it("refuses an administrator editing somebody else's report", async () => {
    // The documented bypass, pinned: moderation may archive a report, never
    // rewrite one. An admin used to be able to open a colleague's shared report,
    // change it and save over their work silently.
    const stored = storedReport({ visibility: "shared", id_usuario: AUTHOR });
    findByPk.mockResolvedValue(stored.model);

    const c = call(
      { id: SOMEBODY_ELSE, id_rol: ADMIN },
      { params: { id: "3" }, body: { name: "Secuestrado", config: validConfig } },
    );
    await putReporte(c.req, c.res);

    expect(c.status).toBe(403);
    expect(c.message).toMatch(/solo el autor/i);
    expect(stored.update).not.toHaveBeenCalled();
  });

  it("lets the author edit their own", async () => {
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);

    const c = call(
      { id: AUTHOR, id_rol: TECNICO },
      { params: { id: "3" }, body: { name: "Nuevo nombre", config: validConfig } },
    );
    await putReporte(c.req, c.res);

    expect(c.status).toBe(200);
    expect(stored.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Nuevo nombre" }),
    );
  });

  it("revalidates a configuration that is being changed, before storing it", async () => {
    // Saving validates by building the query, so a report that names a field
    // that does not exist is refused at save time instead of failing on every
    // run afterwards — for its author and for everyone it was shared with.
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);

    const c = call(
      { id: AUTHOR, id_rol: TECNICO },
      {
        params: { id: "3" },
        body: { name: "Roto", config: { root: "evento", columns: [{ path: "no_existe" }] } },
      },
    );
    await putReporte(c.req, c.res);

    expect(c.status).toBe(400);
    expect(stored.update).not.toHaveBeenCalled();
  });

  it("does not revalidate what was not sent", async () => {
    // The mirror of the test above, and the reason `hasOwn` is used rather than
    // a truthiness check: a body that carries only `favorite` must not be made
    // to answer for a stored configuration it is not touching — otherwise a
    // report saved before a field was removed could never be un-favourited.
    const stored = storedReport({ config: { root: "evento", columns: [{ path: "no_existe" }] } });
    findByPk.mockResolvedValue(stored.model);

    const c = call(
      { id: AUTHOR, id_rol: TECNICO },
      { params: { id: "3" }, body: { favorite: true } },
    );
    await putReporte(c.req, c.res);

    expect(c.status).toBe(200);
    expect(stored.update).toHaveBeenCalledWith(expect.objectContaining({ favorite: true }));
  });

  it("keeps the stored configuration when only the favourite flag is sent", async () => {
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);

    const c = call(
      { id: AUTHOR, id_rol: TECNICO },
      { params: { id: "3" }, body: { favorite: true } },
    );
    await putReporte(c.req, c.res);

    expect(stored.update).toHaveBeenCalledWith(
      expect.objectContaining({ favorite: true, name: "Reporte de Ana", config: validConfig }),
    );
  });
});

describe("archiving a saved report", () => {
  it("lets whoever may moderate archive anyone's", async () => {
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);
    grant(ADMIN, "seguridad.editar");

    const c = call({ id: SOMEBODY_ELSE, id_rol: ADMIN }, { params: { id: "3" } });
    await deleteReporte(c.req, c.res);

    expect(c.status).toBe(200);
    expect(stored.destroy).toHaveBeenCalled();
  });

  it("stops anyone else archiving what is not theirs", async () => {
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);

    const c = call({ id: SOMEBODY_ELSE, id_rol: SUPERVISOR }, { params: { id: "3" } });
    await deleteReporte(c.req, c.res);

    expect(c.status).toBe(403);
    expect(stored.destroy).not.toHaveBeenCalled();
  });

  it("does not let the route's own permission double as moderation", async () => {
    // Every caller here already holds `generador.archivar` — the route gate
    // requires it — so if that were the question asked, anybody could archive
    // anybody's report. The one being asked has to be a different one.
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);
    grant(SUPERVISOR, "generador.archivar", "generador.editar", "generador.ver", "generador.crear");

    const c = call({ id: SOMEBODY_ELSE, id_rol: SUPERVISOR }, { params: { id: "3" } });
    await deleteReporte(c.req, c.res);

    expect(c.status).toBe(403);
    expect(stored.destroy).not.toHaveBeenCalled();
  });
});

describe("duplicating a saved report", () => {
  it("refuses to copy a private report belonging to somebody else", async () => {
    findByPk.mockResolvedValue(storedReport({ visibility: "private" }).model);

    const c = call({ id: SOMEBODY_ELSE, id_rol: SUPERVISOR }, { params: { id: "3" } });
    await postDuplicar(c.req, c.res);

    expect(c.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("copies into the caller's account, always private", async () => {
    findByPk.mockResolvedValue(storedReport({ visibility: "shared" }).model);
    create.mockResolvedValue({ dataValues: { id: 12 } });

    const c = call({ id: SOMEBODY_ELSE, id_rol: SUPERVISOR }, { params: { id: "3" } });
    await postDuplicar(c.req, c.res);

    expect(c.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id_usuario: SOMEBODY_ELSE, visibility: "private" }),
    );
  });
});

describe("creating a saved report", () => {
  it("takes the owner from the session and never from the body", async () => {
    create.mockResolvedValue({ dataValues: { id: 12 } });

    const c = call(
      { id: AUTHOR, id_rol: TECNICO },
      { body: { name: "Mío", config: validConfig, id_usuario: SOMEBODY_ELSE } },
    );
    await postReporte(c.req, c.res);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id_usuario: AUTHOR }));
  });

  it("refuses a configuration the builder cannot accept, before storing it", async () => {
    // Validating at save time is the whole reason `buildQuery` runs here: a
    // report that saves and then fails on every run is worse than a refusal.
    const c = call(
      { id: AUTHOR, id_rol: TECNICO },
      { body: { name: "Roto", config: { root: "noexiste", columns: [{ path: "id" }] } } },
    );
    await postReporte(c.req, c.res);

    expect(c.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a payload the database column could not hold", async () => {
    const cases: [string, unknown][] = [
      ["sin nombre", { config: validConfig }],
      ["nombre en blanco", { name: "   ", config: validConfig }],
      ["nombre larguísimo", { name: "x".repeat(121), config: validConfig }],
      ["descripción larguísima", { name: "ok", config: validConfig, description: "x".repeat(501) }],
      ["visibilidad inventada", { name: "ok", config: validConfig, visibility: "public" }],
      ["sin configuración", { name: "ok" }],
    ];

    for (const [what, body] of cases) {
      vi.clearAllMocks();
      const c = call({ id: AUTHOR, id_rol: TECNICO }, { body });
      await postReporte(c.req, c.res);

      expect(c.status, what).toBe(400);
      expect(create, what).not.toHaveBeenCalled();
    }
  });
});

describe("the identifier in the path", () => {
  it("is refused before it reaches the database when it is not one", async () => {
    for (const id of ["0", "-3", "1.5", "abc", "", "null", " "]) {
      vi.clearAllMocks();
      findByPk.mockResolvedValue(null);

      const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id } });
      await getReporte(c.req, c.res);

      expect(c.status, JSON.stringify(id)).toBe(400);
      expect(findByPk, JSON.stringify(id)).not.toHaveBeenCalled();
    }
  });

  it("reads only the first value when it arrives repeated", async () => {
    // Express types the parameter as `string | string[]`, and a crafted request
    // can send an array. Comparing one to a number is always false, so the
    // guard takes the first value rather than letting the whole thing coerce to
    // NaN — the same choice `requireSelfOrRole` makes one layer up.
    vi.clearAllMocks();
    findByPk.mockResolvedValue(null);

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id: ["1", "2"] } });
    await getReporte(c.req, c.res);

    expect(findByPk).toHaveBeenCalledWith(1);
    expect(c.status).toBe(404);
  });

  it("accepts any spelling of a whole number, including an exponent", async () => {
    // The parser is `Number()`, not a digit check, so "1e3" is the number 1000
    // written differently rather than something to refuse. Recorded because it
    // looks like an oversight and is not one.
    vi.clearAllMocks();
    findByPk.mockResolvedValue(null);

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id: "1e3" } });
    await getReporte(c.req, c.res);

    expect(findByPk).toHaveBeenCalledWith(1000);
  });
});

describe("what an error tells the caller", () => {
  it("never echoes the database back", async () => {
    // The message leaks physical table and column names — an oracle for anyone
    // probing the schema, and unreadable for the user anyway.
    findByPk.mockRejectedValue({
      parent: { code: "42883", message: 'no existe la función sum(character varying)' },
    });

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id: "3" } });
    await getReporte(c.req, c.res);

    expect(c.status).toBe(500);
    expect(c.message).not.toMatch(/sum\(|revicions|42883|character varying/);
    expect(c.message).toMatch(/no se pudo/i);
  });

  it("calls a timed-out query the caller's problem, not a server fault", async () => {
    findByPk.mockRejectedValue({ parent: { code: "57014" } });

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id: "3" } });
    await getReporte(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/rango de fechas|columnas/i);
  });

  it("calls a value Postgres cannot read a bad request, not a server fault", async () => {
    // The net under the validation. Every one of these is a filter value the
    // builder should have refused first, and while it exists the caller has to
    // be told it is their filter and not the server: a 500 saying "no se pudo
    // generar el reporte" for one character in one box sends them to look at
    // the wrong thing. The whole class is mapped, not the one code that was
    // reported: 22P02 was reached by typing 2,5, and the eleven other shapes
    // that got through arrived as 22007, 22003 and 22008.
    for (const code of ["22P02", "22007", "22003", "22008"]) {
      findByPk.mockRejectedValue({ parent: { code } });

      const c = call({ id: AUTHOR, id_rol: ADMIN }, { params: { id: "3" } });
      await getReporte(c.req, c.res);

      expect(c.status, code).toBe(400);
      expect(c.message).toMatch(/filtros/i);
      // Still nothing about the schema, the value, or the code.
      expect(c.message).not.toMatch(new RegExp(code));
    }
  });
});

/**
 * Running a report — the endpoint that actually extracts data, and the one with
 * no tests of its own until now. `buildQuery` is deliberately not mocked: half
 * of what these assertions are about is the order in which this handler
 * validates and measures.
 */
describe("running a report", () => {
  const config = (over: Record<string, unknown> = {}) => ({
    root: "evento",
    columns: [{ path: "id" }],
    ...over,
  });

  it("validates the configuration before it measures its size", async () => {
    // A configuration naming a field that does not exist used to come back as
    // "too many cells", which sends somebody to delete columns that were not
    // the problem — the same inversion the export path had already been fixed
    // for, reintroduced here.
    const c = call(
      { id: AUTHOR, id_rol: ADMIN },
      { body: config({ columns: [{ path: "no_existe" }], limit: 1_000_000 }) },
    );
    await postConsulta(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/no existe/i);
    expect(c.message).not.toMatch(/celdas/i);
    expect(runReport).not.toHaveBeenCalled();
  });

  it("measures the limit it will use, not the one it was asked for", async () => {
    // `limit` is clamped to MAX_ROWS downstream, so a request for a million rows
    // of one column was refused quoting a million cells — a size the answer
    // could never have reached, and a sixth of the cap once clamped.
    const c = call({ id: AUTHOR, id_rol: ADMIN }, { body: config({ limit: 1_000_000 }) });
    await postConsulta(c.req, c.res);

    expect(c.status).toBe(200);
    expect(runReport).toHaveBeenCalledTimes(1);
  });

  it("refuses a page that really is too large", async () => {
    // Ten columns at the row ceiling is half a million cells against a cap of
    // three hundred thousand, and the refusal names both levers.
    const wide = config({
      columns: Array.from({ length: 10 }, () => ({ path: "id" })),
      limit: 50_000,
    });
    const c = call({ id: AUTHOR, id_rol: ADMIN }, { body: wide });
    await postConsulta(c.req, c.res);

    expect(c.status).toBe(413);
    expect(c.message).toMatch(/celdas/);
    expect(c.message).toMatch(/filas por página|quite columnas/i);
    expect(runReport).not.toHaveBeenCalled();
  });

  it("leaves a trace of who extracted what, with their address", async () => {
    // The one operation that actually reads data was the only one with no audit
    // entry: somebody paging through the whole dataset was invisible while
    // renaming a saved report was logged. And no entry here carried an IP, while
    // the rest of the system has recorded one for months.
    runReport.mockResolvedValue({
      columns: [], rows: [{ id: 1 }, { id: 2 }], total: 2, limit: 100, offset: 0,
    });

    const c = call({ id: AUTHOR, id_rol: ADMIN }, { body: config() });
    (c.req as unknown as { ip: string }).ip = "10.0.0.9";
    await postConsulta(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RUN_REPORTE",
        id_usuario: AUTHOR,
        ip_address: "10.0.0.9",
      }),
    );
  });

  it("refuses a field the caller may not see, whatever their role number", async () => {
    // The catalog's staff-only fields are resolved against `seguridad.ver` now.
    // Nothing is granted in this test, so the answer is no — and it is the same
    // no for role 1, which is the point of asking the matrix instead of the
    // number.
    const c = call({ id: AUTHOR, id_rol: ADMIN }, { body: config({
      columns: [{ path: "usuario.user" }],
    }) });
    await postConsulta(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/permiso/i);
    expect(runReport).not.toHaveBeenCalled();
  });

  it("hands the catalog over trimmed to what the caller may see", async () => {
    const sin = call({ id: AUTHOR, id_rol: TECNICO });
    await getCatalogo(sin.req, sin.res);
    const withoutStaff = JSON.stringify(sin.payload);

    grant(ADMIN, "seguridad.ver");
    const con = call({ id: AUTHOR, id_rol: ADMIN });
    await getCatalogo(con.req, con.res);
    const withStaff = JSON.stringify(con.payload);

    expect(withoutStaff).not.toContain("usuario.user");
    expect(withStaff).toContain("usuario.user");
  });
});
