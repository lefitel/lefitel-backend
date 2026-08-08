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
const findAll = vi.fn();
const create = vi.fn();

vi.mock("../models/reporteVista.model.js", () => ({
  ReporteVistaModel: {
    findByPk: (...args: unknown[]) => findByPk(...args),
    findAll: (...args: unknown[]) => findAll(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: { name: "UsuarioModel" } }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));

const {
  getReporte, getReportes, postReporte, putReporte, deleteReporte, postDuplicar,
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
  { params = {}, body = {} }: { params?: Record<string, unknown>; body?: unknown } = {},
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
    req: { user, params, body } as unknown as Request,
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
  it("never hands another author's name to a role that cannot see people", async () => {
    // The catalog hides personal data from role 3. The listing would have given
    // it back through the author of every shared report.
    findAll.mockResolvedValue([]);

    await getReportes(call({ id: AUTHOR, id_rol: TECNICO }).req, call(undefined).res);
    const forTecnico = findAll.mock.calls[0][0] as { include: { attributes: string[] }[] };
    expect(forTecnico.include[0].attributes).toEqual(["id"]);

    await getReportes(call({ id: AUTHOR, id_rol: SUPERVISOR }).req, call(undefined).res);
    const forSupervisor = findAll.mock.calls[1][0] as { include: { attributes: string[] }[] };
    expect(forSupervisor.include[0].attributes).toContain("name");
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
  it("lets an administrator archive anyone's", async () => {
    const stored = storedReport();
    findByPk.mockResolvedValue(stored.model);

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
});
