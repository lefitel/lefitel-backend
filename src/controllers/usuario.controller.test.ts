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
  };
}

/** A stored user whose writes are observable. */
function storedUser() {
  const save = vi.fn();
  const set = vi.fn();
  const destroy = vi.fn();
  return {
    save,
    set,
    destroy,
    model: {
      dataValues: { id: SELF, user: "ana", pass: "hash-viejo", image: null, id_rol: TECNICO },
      set,
      save,
      destroy,
      update: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
