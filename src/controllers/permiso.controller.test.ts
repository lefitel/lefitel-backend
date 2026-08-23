// Saving the permission matrix.
//
// This is the endpoint that hands out authority, so the cases that matter are
// the ones where it must say no: a module name that does not exist, a value that
// is not a yes or a no, and above all the caller editing their own role — the
// one mistake on this screen with no way back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findByPk = vi.fn();
const findAll = vi.fn();
const update = vi.fn();
const create = vi.fn();
const transaction = vi.fn();

vi.mock("../models/rol.model.js", () => ({
  RolModel: {
    findByPk: (...args: unknown[]) => findByPk(...args),
    findAll: (...args: unknown[]) => findAll(...args),
  },
}));
vi.mock("../models/permiso.model.js", () => ({
  PermisoModel: {
    update: (...args: unknown[]) => update(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...args: unknown[]) => transaction(...args) },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));

const permissionsFor = vi.fn();
const invalidatePermissions = vi.fn();
const allPermissions = vi.fn();
vi.mock("../permissions/store.js", () => ({
  permissionsFor: (...args: unknown[]) => permissionsFor(...args),
  invalidatePermissions: () => invalidatePermissions(),
  allPermissions: () => allPermissions(),
}));

const { getPermisos, putPermisos } = await import("./permiso.controller.js");
const { MODULES, ACTIONS, emptyPermissions } = await import("../permissions/matrix.js");

const ADMIN = 1;
const COORDINADOR = 2;

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
    req: { user, params, body, ip: "::1" } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as Record<string, unknown>;
    },
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  permissionsFor.mockResolvedValue(emptyPermissions());
  allPermissions.mockResolvedValue({});
  findAll.mockResolvedValue([]);
  findByPk.mockResolvedValue({ dataValues: { id: COORDINADOR, name: "Coordinador" } });
  update.mockResolvedValue([1]);
  // Run the callback straight through: the transaction itself is Sequelize's
  // business, what it wraps is ours.
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
});

describe("reading the matrix", () => {
  it("sends the vocabulary with the data", async () => {
    // The screen draws a row per module and a column per action from this. If it
    // kept its own list, a module added later would silently never appear.
    const c = call({ id: 1, id_rol: ADMIN });
    await getPermisos(c.req, c.res);

    expect(c.status).toBe(200);
    expect((c.payload.modulos as { key: string }[]).map((m) => m.key)).toEqual([...MODULES]);
    expect((c.payload.acciones as { key: string }[]).map((a) => a.key)).toEqual([...ACTIONS]);
  });

  // `getMisPermisos` was asserted here — "reports only the caller's own
  // permissions on the personal route" — until `GET /api/permisos/mias` was
  // retired and the handler went with it. Nothing called that route: the matrix
  // travels in `GET /api/auth/me`'s answer now, and what pins *that* is
  // `auth.controller.test.ts`'s "reads the role from the database and not from
  // the credential". The test is not missing, it moved with the endpoint.
});

describe("saving", () => {
  it("refuses the caller editing their own role", async () => {
    // Unticking your own access to this screen cannot be undone by you, and
    // nobody else can reach it either. The refusal is the escape hatch.
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: String(ADMIN) }, body: { permisos: { roles: { editar: false } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(409);
    expect(c.message).toMatch(/su propio rol/i);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a module that does not exist", async () => {
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "2" }, body: { permisos: { contabilidad: { ver: true } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/contabilidad/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an action that does not exist", async () => {
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "2" }, body: { permisos: { eventos: { exportar: true } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/exportar/);
  });

  it("refuses a value that is not yes or no", async () => {
    // "true" is not true. A string would be stored and read back as truthy,
    // granting something nobody ticked.
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "2" }, body: { permisos: { eventos: { ver: "true" } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/verdadero o falso/i);
  });

  it("refuses a body with no permissions in it", async () => {
    const c = call({ id: 1, id_rol: ADMIN }, { params: { id_rol: "2" }, body: {} });
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(400);
  });

  it("answers 404 for a role that is not there", async () => {
    findByPk.mockResolvedValue(null);
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "99" }, body: { permisos: { eventos: { ver: true } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(404);
  });

  it("writes only the cells that actually moved", async () => {
    // The screen sends its state; without this a single tick would rewrite forty
    // rows and log "changed permissions" as though everything had changed.
    const before = emptyPermissions();
    before.eventos.ver = true;
    permissionsFor.mockResolvedValue(before);

    const c = call(
      { id: 1, id_rol: ADMIN },
      {
        params: { id_rol: "2" },
        body: { permisos: { eventos: { ver: true, crear: true } } },
      },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1].where).toMatchObject({
      id_rol: 2,
      modulo: "eventos",
      accion: "crear",
    });
  });

  it("says so and writes nothing when nothing moved", async () => {
    const before = emptyPermissions();
    before.eventos.ver = true;
    permissionsFor.mockResolvedValue(before);

    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "2" }, body: { permisos: { eventos: { ver: true } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
    expect(invalidatePermissions).not.toHaveBeenCalled();
  });

  it("creates the row when a role predates the module", async () => {
    update.mockResolvedValue([0]);
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "2" }, body: { permisos: { roles: { ver: true } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id_rol: 2, modulo: "roles", accion: "ver", permitido: true }),
      expect.anything(),
    );
  });

  it("makes the change visible and records who made it", async () => {
    const { logAction } = await import("../utils/logAction.js");
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "2" }, body: { permisos: { eventos: { archivar: true } } } },
    );
    await putPermisos(c.req, c.res);

    // Without this the server keeps answering from the cache it read before.
    expect(invalidatePermissions).toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "UPDATE_PERMISOS", severity: "critical" }),
    );
  });

  it("refuses a role id that is not a number", async () => {
    const c = call(
      { id: 1, id_rol: ADMIN },
      { params: { id_rol: "dos" }, body: { permisos: { eventos: { ver: true } } } },
    );
    await putPermisos(c.req, c.res);

    expect(c.status).toBe(400);
  });
});
