// Who may act on a user record.
//
// The most sensitive permissions in the API and the least protected: creating,
// archiving, renaming and — above all — changing a password. The guards are
// hand-rolled per handler rather than delegated to the middleware, so each one
// is its own opportunity to get it wrong, and each is pinned here.
//
// The three guards labelled "IDOR protection" used to read
// `if (loggedUser && …)`, which skips the whole check when there is no session
// instead of refusing. `authenticateToken` runs first on every route, so it was
// not reachable — but a guard that depends on another guard having run is not
// defence in depth, and the tests below fail if it goes back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findOne = vi.fn();
const create = vi.fn();
const findAll = vi.fn();

vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...args: unknown[]) => findOne(...args),
    create: (...args: unknown[]) => create(...args),
    findAll: (...args: unknown[]) => findAll(...args),
  },
}));
vi.mock("../models/rol.model.js", () => ({ RolModel: { findByPk: vi.fn() } }));
// The permission matrix is mocked rather than read: what is under test is what
// this controller does with an answer, not which answer the database gives.
// requirePermission.test.ts and permissions/store.test.ts cover the rest.
const can = vi.fn();
vi.mock("../permissions/store.js", () => ({ can: (...args: unknown[]) => can(...args) }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));

const { createUsuario, updateUsuario, updateUserName, updateUserPass, deleteUsuario } =
  await import("./usuario.controller.js");

const ADMIN = 1;
const TECNICO = 3;
const SELF = 7;
const OTHER = 99;

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
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
    get payload() {
      return res.body;
    },
  };
}

/** A stored user whose writes are observable. */
function storedUser(overrides: Record<string, unknown> = {}) {
  const save = vi.fn();
  const set = vi.fn();
  const destroy = vi.fn();
  const dataValues = {
    id: SELF,
    user: "ana",
    pass: "hash-viejo",
    image: null,
    id_rol: TECNICO,
    ...overrides,
  };
  return {
    save,
    set,
    destroy,
    dataValues,
    model: {
      dataValues,
      set,
      save,
      destroy,
      update: vi.fn(),
      toJSON: () => ({ ...dataValues }),
    },
  };
}

/** The single object handed to `set()` on a successful write. */
function written(set: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(set).toHaveBeenCalledTimes(1);
  return set.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The matrix as the migration seeds it: administration holds everything, and
  // the other roles hold nothing in these two modules.
  can.mockImplementation(async (rol: number) => rol === ADMIN);
});

describe("creating and archiving users", () => {
  it("is refused to everyone but an administrator", async () => {
    for (const handler of [createUsuario, deleteUsuario]) {
      vi.clearAllMocks();
      const c = call({ id: SELF, id_rol: TECNICO }, { params: { id: "8" }, body: { user: "x" } });
      await handler(c.req, c.res);

      expect(c.status, handler.name).toBe(403);
      expect(create, handler.name).not.toHaveBeenCalled();
      expect(findOne, handler.name).not.toHaveBeenCalled();
    }
  });

  it("is refused when there is no session at all", async () => {
    for (const handler of [createUsuario, deleteUsuario]) {
      vi.clearAllMocks();
      const c = call(undefined, { params: { id: "8" }, body: { user: "x" } });
      await handler(c.req, c.res);

      expect(c.status, handler.name).toBe(403);
    }
  });
});

describe("editing a user record", () => {
  const editors = [
    ["updateUsuario", updateUsuario, { name: "Ana" }],
    ["updateUserName", updateUserName, { user: "ana2" }],
    ["updateUserPass", updateUserPass, { pass: "nueva", oldPass: "vieja" }],
  ] as const;

  it("stops a user reaching for somebody else's record", async () => {
    for (const [what, handler, body] of editors) {
      vi.clearAllMocks();
      const c = call({ id: SELF, id_rol: TECNICO }, { params: { id: String(OTHER) }, body });
      await handler(c.req, c.res);

      expect(c.status, what).toBe(403);
      expect(findOne, what).not.toHaveBeenCalled();
    }
  });

  it("refuses rather than proceeds when there is no session", async () => {
    // The regression this file exists for. `if (loggedUser && …)` let an
    // unauthenticated request straight through to the write.
    for (const [what, handler, body] of editors) {
      vi.clearAllMocks();
      const c = call(undefined, { params: { id: String(OTHER) }, body });
      await handler(c.req, c.res);

      expect(c.status, what).toBe(403);
      expect(findOne, what).not.toHaveBeenCalled();
    }
  });

  it("lets a user act on their own record", async () => {
    for (const [what, handler, body] of editors) {
      vi.clearAllMocks();
      const stored = storedUser();
      findOne.mockResolvedValue(stored.model);

      const c = call({ id: SELF, id_rol: TECNICO }, { params: { id: String(SELF) }, body });
      await handler(c.req, c.res);

      expect(c.status, what).not.toBe(403);
      expect(findOne, what).toHaveBeenCalled();
    }
  });

  it("lets an administrator act on anyone", async () => {
    for (const [what, handler, body] of editors) {
      vi.clearAllMocks();
      const stored = storedUser();
      findOne.mockResolvedValue(stored.model);

      const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) }, body });
      await handler(c.req, c.res);

      expect(c.status, what).not.toBe(403);
    }
  });
});

describe("what a request may actually change", () => {
  // `PUT /usuario/:id` used to pass the request body whole to `set()`, and the
  // route lets a person edit their own record. Those two together meant any
  // authenticated account could send `{ id_rol: 1 }` at its own id and come
  // back an administrator — one request, no tooling beyond the browser console.

  it("writes only the profile fields, whatever else was sent", async () => {
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      {
        params: { id: String(SELF) },
        body: {
          name: "Ana",
          phone: "700",
          id: 1,
          user: "root",
          pass: "no-por-aquí",
          deletedAt: null,
        },
      },
    );
    await updateUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(written(stored.set)).toEqual({ name: "Ana", phone: "700" });
  });

  it("refuses somebody without the Roles permission asking for a different role", async () => {
    const { logAction } = await import("../utils/logAction.js");
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { name: "Ana", id_rol: ADMIN } },
    );
    await updateUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(stored.set).not.toHaveBeenCalled();
    expect(stored.save).not.toHaveBeenCalled();
    // Somebody reaching for administrator is exactly what the audit log is for.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ROLE_CHANGE_DENIED", severity: "critical" }),
    );
  });

  it("lets the profile page echo the current role back untouched", async () => {
    // PerfilPage spreads the whole user object into its payload, id_rol
    // included. Refusing that would break saving your own name.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { name: "Ana", id_rol: TECNICO } },
    );
    await updateUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(written(stored.set)).toEqual({ name: "Ana" });
  });

  it("lets the Roles permission move somebody between roles", async () => {
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(SELF) }, body: { name: "Ana", id_rol: ADMIN } },
    );
    await updateUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(written(stored.set)).toEqual({ name: "Ana", id_rol: ADMIN });
  });

  it("stops even administration rewriting a username or password through this route", async () => {
    // Both have their own endpoint: one checks the name is free, the other
    // hashes. Letting them through here would skip both.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(SELF) }, body: { user: "root", pass: "texto-plano" } },
    );
    await updateUsuario(c.req, c.res);

    expect(written(stored.set)).toEqual({});
  });

  it("stops a user editor promoting themselves", async () => {
    // The reason `roles` is its own module. Someone granted seguridad.editar —
    // enough to fix a colleague's telephone number — must not thereby be able
    // to hand out administrator.
    can.mockImplementation(async (_rol: number, modulo: string) => modulo === "seguridad");
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: 2 },
      { params: { id: String(SELF) }, body: { name: "Ana", id_rol: ADMIN } },
    );
    await updateUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(stored.set).not.toHaveBeenCalled();
  });

  it("never sends the password hash back", async () => {
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { name: "Ana" } },
    );
    await updateUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload).not.toHaveProperty("pass");
    expect(JSON.stringify(c.payload)).not.toContain("hash-viejo");
  });
});

describe("changing a password", () => {
  it("demands the current one from anybody who is not an administrator", async () => {
    findOne.mockResolvedValue(storedUser().model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "nueva" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toMatch(/contraseña actual/i);
  });

  it("refuses when the current one is wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "nueva", oldPass: "equivocada" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(401);
    expect(stored.save).not.toHaveBeenCalled();
  });

  it("lets an administrator reset one without knowing it", async () => {
    // Deliberate: an administrator resets a password precisely because the user
    // cannot supply the old one.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(OTHER) }, body: { pass: "nueva" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(stored.save).toHaveBeenCalled();
  });

  it("stores a hash and never the password itself", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "nueva", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(bcryptjs.hash).toHaveBeenCalledWith("nueva", 8);
    expect(stored.set).toHaveBeenCalledWith(expect.objectContaining({ pass: "hashed" }));
  });
});
