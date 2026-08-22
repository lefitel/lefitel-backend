// Who may act on a user record.
//
// The most sensitive permissions in the API and the least protected: creating,
// archiving, renaming and — above all — changing a password. The guards are
// hand-rolled per handler rather than delegated to the middleware, so each one
// is its own opportunity to get it wrong, and each is pinned here.
//
// The three guards labelled "IDOR protection" used to read
// `if (loggedUser && …)`, which skips the whole check when there is no session
// instead of refusing. `authenticate` runs first on every route, so it was
// not reachable — but a guard that depends on another guard having run is not
// defence in depth, and the tests below fail if it goes back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { LOCKOUT_AFTER_FAILURES } from "../config/security.js";

const findOne = vi.fn();
const create = vi.fn();
const findAll = vi.fn();
const restore = vi.fn();
const destroy = vi.fn();

vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...args: unknown[]) => findOne(...args),
    create: (...args: unknown[]) => create(...args),
    findAll: (...args: unknown[]) => findAll(...args),
    restore: (...args: unknown[]) => restore(...args),
    destroy: (...args: unknown[]) => destroy(...args),
  },
}));
// Two things this controller reaches for now that it ends sessions: the store,
// and a transaction to end them in. Mocked rather than real — what is under
// test is which sessions this controller asks to end and inside what, not the
// SQL, which is `sessionStore.test.ts`'s business.
//
// The store also *has* to be mocked for this file to load at all: it imports
// `sesion.model.ts`, which calls `UsuarioModel.hasMany` while being imported,
// and `UsuarioModel` here is the plain object above with no such method.
const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  revokeAllSessionsOf: (...args: unknown[]) => revokeAllSessionsOf(...args),
}));
const transaction = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...args: unknown[]) => transaction(...args) },
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

const {
  createUsuario,
  updateUsuario,
  updateUserName,
  updateUserPass,
  deleteUsuario,
  desarchivarUsuario,
  desbloquearUsuario,
} = await import("./usuario.controller.js");

const ADMIN = 1;
const TECNICO = 3;
const SELF = 7;
const OTHER = 99;

function call(
  user: { id: number; id_rol: number; id_sesion?: string } | undefined,
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
    // deleteUsuario and desarchivarUsuario answer success with `res.sendStatus`
    // rather than `res.status().json()`. Nothing exercised that path until the
    // restore tests below, which is why this was missing.
    sendStatus(code: number) {
      this.statusCode = code;
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

/** Stands in for the Sequelize transaction the archive runs inside. */
const TRANSACCION = { id: "una-transaccion" };

beforeEach(() => {
  vi.clearAllMocks();
  // The matrix as the migration seeds it: administration holds everything, and
  // the other roles hold nothing in these two modules.
  can.mockImplementation(async (rol: number) => rol === ADMIN);
  destroy.mockResolvedValue(1);
  revokeAllSessionsOf.mockResolvedValue(0);
  // Runs the callback and hands it the stand-in, which is what lets the tests
  // below check that the archive and the revocation received the *same* one.
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
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

/**
 * The same question for the door next to it, which nobody had asked.
 *
 * `updateUsuario` has refused a role change from anybody without the Roles
 * permission since the day that allowlist was written. `createUsuario` built its
 * payload from a blacklist of two field names and let everything else through,
 * `id_rol` included — and its only gate is `seguridad.crear`. So a role holding
 * that and not `roles.editar` — separate modules, separate checkboxes on the
 * Seguridad screen — could POST an account with `id_rol: 1` and log in as a full
 * administrator a second later. One request, from a role that was never meant to
 * hand out authority at all.
 */
describe("what a creation request may set", () => {
  /** Everything in Seguridad, nothing in Roles: the escalation's starting point. */
  function soloSeguridad() {
    can.mockImplementation(async (_rol: number, modulo: string) => modulo === "seguridad");
  }

  it("refuses the escalation, and writes it down", async () => {
    const { logAction } = await import("../utils/logAction.js");
    soloSeguridad();

    const c = call(
      { id: SELF, id_rol: 2 },
      { body: { user: "tmp", pass: "una-clave-de-prueba", id_rol: ADMIN } },
    );
    await createUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    // The same action name `updateUsuario` uses for the same reach: somebody
    // asking for authority they may not hand out is one thing to look for.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ROLE_CHANGE_DENIED", severity: "critical" }),
    );
  });

  it("refuses even when no role was asked for, rather than dying on the column", async () => {
    // Every account is born with a role and `id_rol` is NOT NULL, so without
    // the Roles permission there is nothing this handler can legitimately do.
    // Before, a request that simply left the field out reached the database and
    // came back a 500 with Postgres's own text in it.
    const { logAction } = await import("../utils/logAction.js");
    soloSeguridad();

    const c = call({ id: SELF, id_rol: 2 }, { body: { user: "tmp", pass: "una-clave-de-prueba" } });
    await createUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(c.message).toMatch(/roles/i);
    expect(create).not.toHaveBeenCalled();
    // Not an attack, so not a critical line. Only a refusal.
    expect(logAction).not.toHaveBeenCalled();
  });

  it("writes only the fields a creation may bring, whatever else was sent", async () => {
    // A blacklist accepts every column added to the model from now on, and
    // nobody adding one would think to come here. `id` is an autoincrement
    // primary key, `deletedAt` would make an account born archived, and the two
    // lockout fields are the server's bookkeeping.
    findOne.mockResolvedValueOnce(null);
    create.mockResolvedValue({ dataValues: { id: 42 }, toJSON: () => ({ id: 42 }) });

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      {
        body: {
          user: "nuevo",
          pass: "una-clave-de-prueba",
          name: "Ana",
          phone: "700",
          id_rol: TECNICO,
          id: 999,
          deletedAt: null,
          failed_attempts: 99,
          locked_until: new Date("2100-01-01"),
        },
      },
    );
    await createUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(create.mock.calls[0][0]).toEqual({
      user: "nuevo",
      pass: "hashed",
      name: "Ana",
      phone: "700",
      id_rol: TECNICO,
    });
  });

  it("lets the Roles permission choose the role, which is the point of asking", async () => {
    findOne.mockResolvedValueOnce(null);
    create.mockResolvedValue({ dataValues: { id: 42 }, toJSON: () => ({ id: 42 }) });

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { body: { user: "nuevo", pass: "una-clave-de-prueba", id_rol: TECNICO } },
    );
    await createUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(create.mock.calls[0][0]).toMatchObject({ id_rol: TECNICO });
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
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba" } },
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
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(bcryptjs.hash).toHaveBeenCalledWith("una-clave-de-prueba", 12);
    expect(stored.set).toHaveBeenCalledWith(expect.objectContaining({ pass: "hashed" }));
  });
});

/**
 * The way out of a lockout, of which there were none.
 *
 * `failed_attempts` was only ever cleared by a successful login, and a locked
 * account cannot log in successfully — the login answers before it compares
 * anything. So the count only grew, the wait pinned itself at the ceiling, and
 * one request every quarter of an hour kept an account shut indefinitely from a
 * single address, without coming near any rate-limit bucket. Neither field is on
 * any allowlist and there was no endpoint, so the only remedy was an UPDATE by
 * hand in Postgres.
 *
 * Two ways out now: a password reset clears it as part of the same write, and
 * this endpoint clears it on its own.
 */
describe("lifting a lockout", () => {
  /** When the wait would be over, if nobody lifted it. */
  const HASTA = new Date(Date.now() + 60_000);

  /** An account that has run out of attempts and is resting. */
  function bloqueado() {
    return storedUser({ failed_attempts: LOCKOUT_AFTER_FAILURES, locked_until: HASTA });
  }

  it("comes off with a password reset, in the same write", async () => {
    // The everyday case, and the reason it cannot wait for the endpoint below:
    // an administrator resets a password precisely because somebody cannot get
    // in. With the lock left on they dictate the new password and the login
    // still answers "Usuario o contraseña incorrectos" for up to fifteen
    // minutes — indistinguishable, to either of them, from having heard it
    // wrong.
    const stored = bloqueado();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(written(stored.set)).toEqual({ pass: "hashed", failed_attempts: 0, locked_until: null });
  });

  it("comes off on its own through the unlock endpoint", async () => {
    const stored = bloqueado();
    findOne.mockResolvedValue(stored.model);

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) } });
    await desbloquearUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(written(stored.set)).toEqual({ failed_attempts: 0, locked_until: null });
    expect(stored.save).toHaveBeenCalled();
  });

  it("is refused to anybody who may not edit accounts", async () => {
    const stored = bloqueado();
    findOne.mockResolvedValue(stored.model);

    const c = call({ id: SELF, id_rol: TECNICO }, { params: { id: String(OTHER) } });
    await desbloquearUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(findOne).not.toHaveBeenCalled();
    expect(stored.save).not.toHaveBeenCalled();
  });

  it("is refused when there is no session at all", async () => {
    const c = call(undefined, { params: { id: String(OTHER) } });
    await desbloquearUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("leaves a critical line in the bitácora saying what was undone", async () => {
    // Removing a protection from an account is the sort of thing somebody asks
    // about afterwards. Recorded with the lockout it cleared, so the entry says
    // what was undone rather than merely that something was.
    const { logAction } = await import("../utils/logAction.js");
    const stored = bloqueado();
    findOne.mockResolvedValue(stored.model);

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) } });
    await desbloquearUsuario(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCOUNT_UNLOCKED",
        severity: "critical",
        entity_id: OTHER,
        metadata: { before: { failed_attempts: LOCKOUT_AFTER_FAILURES, locked_until: HASTA } },
      }),
    );
  });

  it("answers 404 rather than unlocking nothing when the id does not exist", async () => {
    findOne.mockResolvedValue(null);

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: "999" } });
    await desbloquearUsuario(c.req, c.res);

    expect(c.status).toBe(404);
  });
});

/**
 * The password policy has two doors — creating an account and changing one —
 * and `validarPassword` itself is only ever exercised directly in
 * `password.test.ts`. Nothing here proved the controllers actually called it:
 * removing the check from either site left every test above still green.
 * These two close that gap.
 */
describe("the password policy at the door", () => {
  it("refuses to create an account with a password that fails the policy", async () => {
    findOne.mockResolvedValueOnce(null); // nombreEnUso: name is free
    const c = call({ id: ADMIN, id_rol: ADMIN }, { body: { user: "nuevo", pass: "corta" } });
    await createUsuario(c.req, c.res);

    expect(c.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to set an account's password to one that fails the policy", async () => {
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) }, body: { pass: "corta" } });
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(400);
    expect(stored.save).not.toHaveBeenCalled();
  });
});

/**
 * `usuarios_user_uniq` closed a real vulnerability — createUsuario used to
 * duplicate a username in silence — but opened a new failure path: three
 * endpoints that used to succeed (or silently misbehave) now hit a database
 * constraint instead. These tests exist so a 500 with raw Postgres text
 * cannot come back unnoticed, and so the case-insensitive gap in
 * updateUserName's own check cannot either.
 */
describe("username collisions", () => {
  function shapedAsUniqueViolation(message: string) {
    return { name: "SequelizeUniqueConstraintError", parent: { constraint: "usuarios_user_uniq" }, message };
  }

  describe("creating a user", () => {
    it("refuses with 409 rather than letting a duplicate name reach the database", async () => {
      findOne.mockResolvedValueOnce(storedUser({ id: 3, user: "isaias" }).model);

      const c = call({ id: ADMIN, id_rol: ADMIN }, { body: { user: "Isaias", pass: "x" } });
      await createUsuario(c.req, c.res);

      expect(c.status).toBe(409);
      expect(create).not.toHaveBeenCalled();
    });

    it("creates the account when the name is free", async () => {
      findOne.mockResolvedValueOnce(null);
      create.mockResolvedValue({
        dataValues: { id: 42 },
        toJSON: () => ({ id: 42, user: "nuevo" }),
      });

      const c = call({ id: ADMIN, id_rol: ADMIN }, { body: { user: "nuevo", pass: "una-clave-de-prueba" } });
      await createUsuario(c.req, c.res);

      expect(c.status).toBe(200);
      expect(create).toHaveBeenCalledOnce();
    });

    it("rejects with 400, not 500, when the body sends a username that is not a string", async () => {
      // `nombreEnUso` calls `.toLowerCase()` on whatever it is given.
      // `POST /usuario` has no body validation, and `tsconfig.json` disables
      // strict mode, so `{ user: 123 }` used to reach `.create()` and become
      // the account "123", silently. Now it has to be rejected before that
      // question is even asked, or `.toLowerCase()` throws and turns into a
      // 500 instead.
      const c = call({ id: ADMIN, id_rol: ADMIN }, { body: { user: 123, pass: "x" } });
      await createUsuario(c.req, c.res);

      expect(c.status).toBe(400);
      expect(findOne).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it("strips failed_attempts and locked_until from what a creation request may set", async () => {
      // These are control fields the server manages, not profile data. Left
      // open, anyone who may create accounts could seed a `locked_until` far
      // in the future on the very account they create.
      findOne.mockResolvedValueOnce(null);
      create.mockResolvedValue({
        dataValues: { id: 42 },
        toJSON: () => ({ id: 42, user: "nuevo" }),
      });

      const c = call(
        { id: ADMIN, id_rol: ADMIN },
        { body: { user: "nuevo", pass: "una-clave-de-prueba", failed_attempts: 99, locked_until: new Date("2100-01-01") } },
      );
      await createUsuario(c.req, c.res);

      const payload = create.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("failed_attempts");
      expect(payload).not.toHaveProperty("locked_until");
    });

    it("still answers 409, not raw Postgres text, when the race wins", async () => {
      // The pre-check saw the name as free; the write lost a race with another
      // request that took it a moment later. The constraint is the one honest
      // answer here — it just must not reach the client verbatim.
      findOne.mockResolvedValueOnce(null);
      create.mockRejectedValueOnce(
        shapedAsUniqueViolation('duplicate key value violates unique constraint "usuarios_user_uniq"'),
      );

      const c = call({ id: ADMIN, id_rol: ADMIN }, { body: { user: "isaias", pass: "una-clave-de-prueba" } });
      await createUsuario(c.req, c.res);

      expect(c.status).toBe(409);
      expect(c.message).not.toMatch(/constraint|duplicate key/i);
    });
  });

  describe("renaming a user", () => {
    it("catches a case-insensitive collision the exact-match check used to miss", async () => {
      // `isaias` exists; renaming another account to `Isaias` used to pass
      // updateUserName's own check (case-sensitive) and die on the database
      // (case-insensitive) with a 500 instead of the 409 this endpoint already
      // knows how to give.
      //
      // `findOne` here is a bare mock that returns the queued row regardless
      // of what it was asked — so the *old*, case-sensitive
      // `findOne({ where: { user } })` would pass this test too (it would
      // still get the row back, and `3 !== 7` still says "someone else has
      // it"). The 409 alone does not prove the fix; the query that produced
      // it does. Asserting on `findOne.mock.calls[0][0]` closes that, and
      // catches a second, unrelated regression the same way: if `nombreEnUso`
      // ever grows a `paranoid: false`, it would start counting archived rows
      // as "taken" too — exactly the Critical this round fixed — and every
      // test would stay green unless something looks at the call itself.
      findOne.mockResolvedValueOnce(storedUser({ id: 3, user: "isaias" }).model);

      const c = call(
        { id: SELF, id_rol: TECNICO },
        { params: { id: String(SELF) }, body: { user: "Isaias" } },
      );
      await updateUserName(c.req, c.res);

      expect(c.status).toBe(409);

      expect(findOne).toHaveBeenCalledOnce();
      const options = findOne.mock.calls[0][0] as { where: unknown };
      // lower("user") = 'isaias' — not the exact string "Isaias" that was sent.
      expect(options.where).toMatchObject({
        attribute: { fn: "lower", args: [{ col: "user" }] },
        comparator: "=",
        logic: "isaias",
      });
      expect(options).not.toHaveProperty("paranoid");
    });

    it("rejects with 400, not 500, when the body sends a username that is not a string", async () => {
      const c = call(
        { id: SELF, id_rol: TECNICO },
        { params: { id: String(SELF) }, body: { user: 123 } },
      );
      await updateUserName(c.req, c.res);

      expect(c.status).toBe(400);
      expect(findOne).not.toHaveBeenCalled();
    });

    it("still answers 409, not raw Postgres text, when the race wins", async () => {
      findOne.mockResolvedValueOnce(null);
      const stored = storedUser();
      findOne.mockResolvedValueOnce(stored.model);
      stored.save.mockRejectedValueOnce(
        shapedAsUniqueViolation('duplicate key value violates unique constraint "usuarios_user_uniq"'),
      );

      const c = call(
        { id: SELF, id_rol: TECNICO },
        { params: { id: String(SELF) }, body: { user: "otronombre" } },
      );
      await updateUserName(c.req, c.res);

      expect(c.status).toBe(409);
      expect(c.message).not.toMatch(/constraint|duplicate key/i);
    });
  });

  describe("restoring an archived user", () => {
    /** A soft-deleted row, as `findOne({ paranoid: false })` would return it. */
    function archivedUser(overrides: Record<string, unknown> = {}) {
      return storedUser({ deletedAt: new Date("2026-08-01"), ...overrides });
    }

    it("is refused to everyone but an administrator", async () => {
      const c = call({ id: SELF, id_rol: TECNICO }, { params: { id: "7" } });
      await desarchivarUsuario(c.req, c.res);

      expect(c.status).toBe(403);
      expect(findOne).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });

    it("restores the account when nobody else holds the name", async () => {
      findOne.mockResolvedValueOnce(archivedUser({ id: 7, user: "isaias" }).model);
      findOne.mockResolvedValueOnce(null);

      const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: "7" } });
      await desarchivarUsuario(c.req, c.res);

      expect(restore).toHaveBeenCalledWith({ where: { id: "7" } });
      expect(c.status).toBe(200);
    });

    it("refuses with 409, and never restores, when the name was given away while archived", async () => {
      // DELETE /usuario/7 archives "isaias" → POST /usuario creates a second
      // "isaias" (createUsuario's own guard above is what actually stops this
      // now, but this is the scenario the constraint alone could not survive)
      // → PATCH /usuario/7/desarchivar must not 500 forever on the same retry.
      findOne.mockResolvedValueOnce(archivedUser({ id: 7, user: "isaias" }).model);
      findOne.mockResolvedValueOnce(storedUser({ id: 8, user: "isaias" }).model);

      const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: "7" } });
      await desarchivarUsuario(c.req, c.res);

      expect(c.status).toBe(409);
      expect(c.message).not.toMatch(/constraint|duplicate key|postgres/i);
      expect(restore).not.toHaveBeenCalled();
    });

    it("answers 404 rather than restoring nothing when the id does not exist", async () => {
      findOne.mockResolvedValueOnce(null);

      const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: "999" } });
      await desarchivarUsuario(c.req, c.res);

      expect(c.status).toBe(404);
      expect(restore).not.toHaveBeenCalled();
    });

    it("still answers 409, not raw Postgres text, when the race wins", async () => {
      findOne.mockResolvedValueOnce(archivedUser({ id: 7, user: "isaias" }).model);
      findOne.mockResolvedValueOnce(null);
      restore.mockRejectedValueOnce(
        shapedAsUniqueViolation('duplicate key value violates unique constraint "usuarios_user_uniq"'),
      );

      const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: "7" } });
      await desarchivarUsuario(c.req, c.res);

      expect(c.status).toBe(409);
      expect(c.message).not.toMatch(/constraint|duplicate key/i);
    });
  });
});

/**
 * What a new password does to the sessions that knew the old one.
 *
 * Nothing, until now. `pass_changed_at` has been on the `usuarios` table since
 * the first migration of this plan and no code has ever read it, so changing a
 * password — the thing you do precisely because somebody else may know the old
 * one — left every browser that knew it logged in for up to thirty days. An
 * administrator resetting the password of somebody who has left the company was
 * doing nothing whatsoever to the laptop in their bag.
 *
 * The exception is the interesting half. Your own current session has to
 * survive, or changing your own password answers 200 and then refuses your very
 * next request, which reads as the change having failed and invites doing it
 * again.
 */
describe("a new password ends the old sessions", () => {
  const MI_SESION = "11111111-1111-4111-8111-111111111111";

  it("ends the others and keeps the one it was changed from", async () => {
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);
    revokeAllSessionsOf.mockResolvedValue(2);

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(SELF, { except: MI_SESION });
  });

  it("ends every one of them when the request arrived on the old token", async () => {
    // A request authenticated by the old JWT has no session row, so there is
    // nothing to spare: everything real gets closed and the person comes back
    // in. `undefined` reaching the store as "spare nothing" is what makes this
    // work — see `sessionStore.test.ts`, where writing that check the obvious
    // way revokes nothing at all.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(SELF, { except: undefined });
  });

  it("spares nothing when an administrator resets somebody else's", async () => {
    // The case the whole thing is for. Sparing anything here would be sparing a
    // session of the person being reset, chosen by an id belonging to the
    // administrator doing the resetting.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN, id_sesion: MI_SESION },
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(OTHER, { except: undefined });
  });

  it("ends nothing when the password was refused", async () => {
    // Every refusal, one loop: a bad current password, a policy failure, and a
    // request with no permission at all. None of them may close a session,
    // because none of them changed anything.
    const bcryptjs = (await import("bcryptjs")).default;

    const casos = [
      ["contraseña actual incorrecta", { pass: "una-clave-de-prueba", oldPass: "mala" }, false],
      ["contraseña nueva demasiado corta", { pass: "corta", oldPass: "vieja" }, true],
    ] as const;

    for (const [what, body, compareOk] of casos) {
      vi.clearAllMocks();
      can.mockImplementation(async (rol: number) => rol === ADMIN);
      vi.mocked(bcryptjs.compare).mockResolvedValue(compareOk as never);
      const stored = storedUser();
      findOne.mockResolvedValue(stored.model);

      const c = call({ id: SELF, id_rol: TECNICO, id_sesion: MI_SESION }, { params: { id: String(SELF) }, body });
      await updateUserPass(c.req, c.res);

      expect(c.status, what).not.toBe(200);
      expect(stored.save, what).not.toHaveBeenCalled();
      expect(revokeAllSessionsOf, what).not.toHaveBeenCalled();
    }
  });
});

/**
 * Archiving an account ends its sessions, in the same transaction.
 *
 * The `ON DELETE RESTRICT` on `sesiones.id_usuario` does nothing here and never
 * will: this is a soft delete, the row stays where it is with a `deletedAt` on
 * it, and no foreign key fires on an UPDATE. So archiving the technician who
 * was let go used to leave his laptop working until the session reached its own
 * expiry — up to thirty days.
 *
 * One transaction because half of this is worse than none. Archived with live
 * sessions is the hole itself; sessions killed without the archive is an
 * account that looks fine to an administrator and cannot be used.
 */
describe("archiving an account ends its sessions", () => {
  it("archives and revokes inside one transaction", async () => {
    revokeAllSessionsOf.mockResolvedValue(2);

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) } });
    await deleteUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    // Both writes, and both carrying the *same* transaction. Either of them
    // outside it would commit on its own, which is precisely the half-done
    // state this is meant to make impossible.
    expect(destroy).toHaveBeenCalledWith({ where: { id: String(OTHER) }, transaction: TRANSACCION });
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(OTHER, { transaction: TRANSACCION });
  });

  it("answers 500 rather than archiving an account whose sessions are still live", async () => {
    // The rollback itself is Sequelize's, not ours. What this pins is that the
    // failure is not swallowed: the caller is told, and retrying does the whole
    // thing rather than leaving somebody archived with a working session.
    revokeAllSessionsOf.mockRejectedValue(new Error("no se pudo revocar"));

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) } });
    await deleteUsuario(c.req, c.res);

    expect(c.status).toBe(500);
  });

  it("revokes nothing when the caller may not archive", async () => {
    const c = call({ id: SELF, id_rol: TECNICO }, { params: { id: String(OTHER) } });
    await deleteUsuario(c.req, c.res);

    expect(c.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });
});
