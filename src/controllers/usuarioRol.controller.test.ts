// Who may hand out a role, and what happens when they do.
//
// This is the handler that took `id_rol` off `PUT /api/usuario/:id`. Two of the
// tests below are that route's old ones, moved: "the Roles permission moves
// somebody between roles" and "it refuses to change the caller's own role" used
// to live in `usuario.controller.test.ts` and were the only witnesses either
// property had. They are here now because here is where the write is.
//
// What this file does **not** cover, and where it does live: the password this
// route asks for on every request. That is a property of the mount, not of the
// handler — `requireStepUp({ sinVentana: true })` in `usuario.routes.ts` — and
// it is pinned as the whole option object in `routeGuards.test.ts`
// (`STEP_UP_OPTIONS`), with the gate's own behaviour in
// `requireStepUp.test.ts`. A handler test cannot see a middleware it is never
// called through, and pretending otherwise is how a mount goes missing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import type { EstadoSesion } from "../auth/sessionState.js";

const usuarioFindByPk = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...args: unknown[]) => usuarioFindByPk(...args) },
}));

const rolFindByPk = vi.fn();
vi.mock("../models/rol.model.js", () => ({
  RolModel: { findByPk: (...args: unknown[]) => rolFindByPk(...args) },
}));

// The matrix is mocked rather than read: what is under test is what this
// handler does with an answer, not which answer the database gives.
// `requirePermission.test.ts` and `permissions/store.test.ts` own the rest.
const can = vi.fn();
vi.mock("../permissions/store.js", () => ({ can: (...args: unknown[]) => can(...args) }));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...args: unknown[]) => logAction(...args) }));

const { asignarRol } = await import("./usuarioRol.controller.js");

const ADMIN = 1;
const COORDINADOR = 2;
const TECNICO = 3;
const YO = 7;
const OTRA = 9;

/** A request shaped the way `authenticate` really produces one. */
function call(
  user: { id: number; id_rol: number } | undefined,
  { params = {}, body = {} }: { params?: Record<string, unknown>; body?: unknown } = {},
) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    // A 204 answers through `end`, never `json`. Leaving it off would not be a
    // quiet gap: the call throws, `makeHandler` files it as a 500, and the test
    // reads "expected 500 to be 204" for a handler that works.
    end() {
      this.ended = true;
      return this;
    },
  };
  return {
    req: {
      user: user && {
        id_sesion: "eeeeeeee-11cd-4111-8111-eeeeeeeeeeee",
        expires_at: new Date("2027-03-14T00:00:00.000Z"),
        estado: "completa" as EstadoSesion,
        mfa_satisfied_at: null,
        ...user,
      },
      params,
      body,
      ip: "::1",
    } as unknown as Request,
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

/** An account whose writes are observable. */
function cuenta(overrides: Record<string, unknown> = {}) {
  const save = vi.fn();
  const set = vi.fn();
  const dataValues = { id: OTRA, user: "ana", id_rol: TECNICO, ...overrides };
  return { save, set, dataValues, model: { dataValues, set, save } };
}

/** A role row as `RolModel.findByPk` returns one. */
const rol = (id: number, name: string, deletedAt: Date | null = null) => ({
  dataValues: { id, name, deletedAt },
});

/** The single object handed to `set()` on a successful write. */
function written(set: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(set).toHaveBeenCalledTimes(1);
  return set.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The matrix as the migration seeds it: administration holds everything, the
  // other roles hold nothing in Roles.
  can.mockImplementation(async (id_rol: number) => id_rol === ADMIN);
  rolFindByPk.mockImplementation(async (id: number) =>
    id === ADMIN ? rol(ADMIN, "Administrador") : id === TECNICO ? rol(TECNICO, "Técnico") : null,
  );
});

describe("who may assign a role", () => {
  it("refuses a caller without the Roles permission, and writes nothing", async () => {
    // The reason `roles` is a module of its own. Somebody granted
    // `seguridad.editar` — enough to fix a colleague's telephone number — must
    // not thereby be able to hand out administrator.
    const objetivo = cuenta();
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: TECNICO }, { params: { id: String(OTRA) }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(403);
    expect(objetivo.set).not.toHaveBeenCalled();
    expect(objetivo.save).not.toHaveBeenCalled();
  });

  it("asks the matrix for roles.editar and nothing else", async () => {
    // The pair, not merely that some question was asked. `seguridad.editar`
    // here would silently merge the two modules the split exists to keep apart,
    // and every assertion above would still pass.
    const objetivo = cuenta();
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(can).toHaveBeenCalledWith(ADMIN, "roles", "editar");
  });

  it("refuses changing the caller's own role, with the permission and all", async () => {
    // `putPermisos`'s precedent, on the account instead of the role: the one
    // mistake with no way back is giving up your own access, and holding
    // `roles.editar` is exactly what gets a request this far.
    const objetivo = cuenta({ id: YO });
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(YO) }, body: { id_rol: TECNICO } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(403);
    expect(c.message).toBe("No puede cambiar su propio rol. Pídaselo a otro administrador.");
    expect(objetivo.set).not.toHaveBeenCalled();
    expect(objetivo.save).not.toHaveBeenCalled();
  });

  it("refuses the caller's own row before it has looked anything up", async () => {
    // Order, and it is the half that a later edit could lose without any of the
    // assertions above noticing: a refusal placed after the lookups would still
    // answer 403, and would have spent two queries on a request that can never
    // succeed.
    usuarioFindByPk.mockResolvedValue(cuenta({ id: YO }).model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(YO) }, body: { id_rol: TECNICO } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(403);
    expect(usuarioFindByPk).not.toHaveBeenCalled();
    expect(rolFindByPk).not.toHaveBeenCalled();
  });
});

describe("what the request has to say", () => {
  it("refuses a body that names no role", async () => {
    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: {} });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(400);
    expect(usuarioFindByPk).not.toHaveBeenCalled();
  });

  // `Number(null)`, `Number("")` and `Number([])` are all zero, so a check
  // written as `Number.isInteger(Number(enviado))` reads every one of these as
  // a request for role 0 instead of refusing it.
  it.each([
    ["null", null],
    ["la cadena vacía", ""],
    ["una lista vacía", []],
    ["un decimal", 1.5],
    ["una palabra", "administrador"],
  ])("refuses %s as a role", async (_nombre, valor) => {
    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: valor } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe("Rol no válido.");
  });

  it("accepts the number as the string a form sends", async () => {
    const objetivo = cuenta();
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: String(ADMIN) } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(204);
    expect(written(objetivo.set)).toEqual({ id_rol: ADMIN });
  });

  it("refuses an address whose id is not a number", async () => {
    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: "ana" }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(400);
    expect(usuarioFindByPk).not.toHaveBeenCalled();
  });
});

describe("the two rows it needs", () => {
  it("answers 404 for an account that is not there", async () => {
    // Archived accounts land here too: `UsuarioModel` is paranoid, so
    // `findByPk` does not see them, and restoring one is what comes first.
    usuarioFindByPk.mockResolvedValue(null);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(404);
    expect(c.message).toBe("Usuario no encontrado");
  });

  it("answers 404 for a role that never existed", async () => {
    usuarioFindByPk.mockResolvedValue(cuenta().model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: 404 } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(404);
    expect(c.message).toBe("Rol no encontrado");
  });

  it("answers 409 for a role the Roles screen archived, and writes nothing", async () => {
    // Told apart from the one above rather than folded into it: the row is read
    // with the archived ones included precisely so the two answers can differ.
    const objetivo = cuenta();
    usuarioFindByPk.mockResolvedValue(objetivo.model);
    rolFindByPk.mockResolvedValue(rol(COORDINADOR, "Coordinador", new Date("2026-09-01T00:00:00.000Z")));

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: COORDINADOR } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(409);
    expect(objetivo.set).not.toHaveBeenCalled();
    expect(objetivo.save).not.toHaveBeenCalled();
    // 🔴 And the option that makes the 409 reachable at all. Measured: with the
    // double standing in for `RolModel`, dropping `paranoid: false` from the
    // lookup leaves every other assertion in this file green — a double does
    // not know what `paranoid` means, so the archived row keeps coming back and
    // the branch keeps firing. Against Postgres the row would simply not be
    // there and this would answer 404. The option is asserted at the call
    // because that is the only place this file can see it.
    expect(rolFindByPk).toHaveBeenCalledWith(COORDINADOR, expect.objectContaining({ paranoid: false }));
  });
});

describe("the write itself", () => {
  it("moves somebody between roles and answers 204 with no body", async () => {
    const objetivo = cuenta({ id_rol: TECNICO });
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(204);
    expect(c.payload).toBeUndefined();
    expect(objetivo.save).toHaveBeenCalledTimes(1);
  });

  it("writes the role and nothing else the body carried", async () => {
    // The allowlist this route replaces existed because `set()` marks every own
    // column present in the object as changed and `save()` writes what is
    // marked. A handler that spread the body here would have re-opened the door
    // the move was meant to close, one segment further along.
    const objetivo = cuenta();
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call(
      { id: YO, id_rol: ADMIN },
      {
        params: { id: String(OTRA) },
        body: { id_rol: ADMIN, user: "root", pass: "texto-plano", deletedAt: null, id: 1 },
      },
    );
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(204);
    expect(written(objetivo.set)).toEqual({ id_rol: ADMIN });
  });

  it("records the change with both role names and severity warning", async () => {
    const objetivo = cuenta({ id_rol: TECNICO });
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(204);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ROLE_ASSIGNED",
        entity: "Usuario",
        entity_id: OTRA,
        id_usuario: YO,
        severity: "warning",
        // Both ends, and by name: an entry that says only which role was
        // handed out cannot answer the question it is read for, which is what
        // the account could do before.
        metadata: {
          before: { id_rol: { id: TECNICO, name: "Técnico" } },
          after: { id_rol: { id: ADMIN, name: "Administrador" } },
        },
      }),
    );
  });

  it("names the previous role even after the Roles screen archived it", async () => {
    // The audit line is read to find out what an account could do *before*, so
    // the row it came from is looked up with the archived ones included. Drop
    // that and the entry reads "from (nothing)" for a change that really moved
    // somebody off a role that was retired afterwards.
    const objetivo = cuenta({ id_rol: COORDINADOR });
    usuarioFindByPk.mockResolvedValue(objetivo.model);
    rolFindByPk.mockImplementation(async (id: number) =>
      id === COORDINADOR
        ? rol(COORDINADOR, "Coordinador", new Date("2026-09-01T00:00:00.000Z"))
        : rol(ADMIN, "Administrador"),
    );

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: ADMIN } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(204);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ before: { id_rol: { id: COORDINADOR, name: "Coordinador" } } }),
      }),
    );
    // And the *new* role is still refused if it is the archived one: the lookup
    // above is for the log, not a way around the check.
    expect(objetivo.save).toHaveBeenCalledTimes(1);
    // Same measurement as the 409 test: the double answers whatever it was told
    // to whether or not the query excludes archived rows, so the only way this
    // file can hold the option is to read it off the call.
    expect(rolFindByPk).toHaveBeenCalledWith(COORDINADOR, expect.objectContaining({ paranoid: false }));
  });

  it("writes nothing and records nothing when the role is already the one asked for", async () => {
    // `putPermisos` answers the same way to a save that moves nothing. An audit
    // log carrying a line that says a role changed from Técnico to Técnico is a
    // log that is harder to read afterwards, and the screen that edits an
    // account sends every field it loaded.
    const objetivo = cuenta({ id_rol: TECNICO });
    usuarioFindByPk.mockResolvedValue(objetivo.model);

    const c = call({ id: YO, id_rol: ADMIN }, { params: { id: String(OTRA) }, body: { id_rol: TECNICO } });
    await asignarRol(c.req, c.res);

    expect(c.status).toBe(204);
    expect(objetivo.set).not.toHaveBeenCalled();
    expect(objetivo.save).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });
});
