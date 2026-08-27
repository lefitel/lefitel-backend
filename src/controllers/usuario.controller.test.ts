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
import type { EstadoSesion } from "../auth/sessionState.js";

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
// Archiving an account also has to cut off the browsers it told to stop asking
// for a second factor. Mocked for the same two reasons as the session store
// above: what is under test is which devices this controller asks to revoke and
// inside what, not the SQL — `rememberedDeviceStore.test.ts` owns that — and the
// real module imports `dispositivoRecordado.model.ts`, which calls
// `UsuarioModel.hasMany` on the plain object standing in for the model here.
const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("../auth/rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...args: unknown[]) => revokeAllRememberedDevicesOf(...args),
}));
// Changing your own password now rotates the session rather than sparing it,
// so this controller opens one. Mocked whole rather than let through: the real
// `issueSession` writes a row, reads the request's cookie and sets a header,
// none of which is what this file is about — `issueSession.ts`'s own tests are.
const issueSession = vi.fn();
vi.mock("../auth/issueSession.js", () => ({
  issueSession: (...args: unknown[]) => issueSession(...args),
}));
const transaction = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...args: unknown[]) => transaction(...args) },
}));
vi.mock("../models/rol.model.js", () => ({ RolModel: { findByPk: vi.fn() } }));
/**
 * The credential door, mocked — deliberately, and this is the one mock in this
 * file worth arguing for.
 *
 * `updateUserName` confirms the caller's own password through
 * `verifyOwnPassword`, and is that function's only caller since
 * `POST /api/auth/confirm-password` was retired. What the function *does* — the
 * shared `checkAgainstRow`, the filler hash, the `PASSWORD_CONFIRM_FAILED` line,
 * leaving the lockout to the login rather than refusing on it, and emphatically
 * not touching `failed_attempts` — is pinned by `auth/verifyOwnPassword.test.ts`
 * and `auth/credentials.test.ts`, and duplicating it here would mean two places
 * to update and one of them silently wrong.
 *
 * What is under test here is only what this controller does with the answer:
 * which requests it asks about at all, and what it refuses with when the answer
 * is no.
 */
const verifyOwnPassword = vi.fn();
vi.mock("../auth/credentials.js", () => ({
  verifyOwnPassword: (...args: unknown[]) => verifyOwnPassword(...args),
}));
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
  CURRENT_PASSWORD_REQUIRED_MESSAGE,
  CURRENT_PASSWORD_WRONG_MESSAGE,
  requiresOwnPassword,
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
/**
 * The session id every caller below gets unless a test names its own, and it is
 * deliberately not the `MI_SESION` the password tests assert against: a test
 * that expects `except: MI_SESION` while relying on this default is a test whose
 * premise slipped, and it should fail rather than pass by coincidence.
 */
const SESION_POR_DEFECTO = "eeeeeeee-11cd-4111-8111-eeeeeeeeeeee";

/**
 * A request, with a `req.user` shaped the way `authenticate` really produces one.
 *
 * `id_sesion` and `expires_at` are filled in for every caller, and *cannot* be
 * left out — which is new. `req.user` declares them required (`app.ts`) now that
 * the credential which arrived without a session row, the old bearer token, is
 * retired; while they were optional this helper cheerfully built a caller with
 * neither, and one test below was about exactly that caller — a self password
 * change whose `id_sesion` was `undefined`, asserting the store was told to
 * spare nothing. It went with the credential. Filling the fields in here is what
 * stops the next one being written, and it costs nothing: a test that needs a
 * particular session id still passes one, and no test can pass none.
 *
 * The rest of the shape stays loose on purpose. This file is about permissions
 * and the IDOR guards, and none of those handlers reads a field beyond `id` and
 * `id_rol`.
 */
function call(
  user: { id: number; id_rol: number; id_sesion?: string; estado?: EstadoSesion } | undefined,
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
    req: {
      // `estado` and `mfa_satisfied_at` are as required on `req.user` as `id` is
      // (see `app.ts`), so they are filled in here rather than left to each
      // test. `completa` is the only state that can reach these routes at all:
      // `sessionState.ts`'s allowlist opens nothing outside `/api/auth/*` to
      // `parcial` or `onboarding`.
      user: user && {
        id_sesion: SESION_POR_DEFECTO,
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
  revokeAllRememberedDevicesOf.mockResolvedValue(0);
  // A default, so that the one test which makes the rotation fail cannot leak
  // its rejection into the tests after it: `vi.clearAllMocks()` clears the
  // recorded calls but keeps the implementation, and a leaked
  // `mockRejectedValue` here surfaces three tests later as an unexplained 500.
  issueSession.mockResolvedValue(undefined);
  // Runs the callback and hands it the stand-in, which is what lets the tests
  // below check that the archive and the revocation received the *same* one.
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
  // Right, unless a test says otherwise. Every rename test below that is about
  // something else — a collision, a race, a permission — sends a password and
  // needs it to be accepted, so the interesting case stays the one the test
  // names.
  verifyOwnPassword.mockResolvedValue({ ok: true });
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
    // `oldPass` is part of a rename's body now, the same as it always was for a
    // password change: renaming your own account has to prove it is you. These
    // four tests are about the IDOR guards, so they send a valid request and
    // let the guard be the only thing that can refuse it.
    ["updateUserName", updateUserName, { user: "ana2", oldPass: "la-mia" }],
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

/**
 * Changing your own password proves it is you. The exemption is for changing
 * somebody else's.
 *
 * **The hole these close, and it was the worst of this plan.** The condition
 * read `if (oldPass) { compare } else if (!mayResetPasswords) { refuse }` — it
 * looked at the *permission* and never at *whose account it is*. So anybody
 * holding `seguridad.editar` could change **their own** password without
 * knowing the current one. On the unattended machine with an administrator's
 * session open, whoever sits down sets a new password, keeps the session that
 * was already there (`isSelf` spares it) and ends every other session of that
 * account in the same write. The owner does not get back in. A rename is
 * repairable by an administrator; this is the account.
 *
 * **Every assertion here names the reason and not only the number.** This
 * handler already answers 400 to a password that fails the policy and 404 to an
 * account that is not there, so a test reading the status alone can pass
 * straight through the wrong branch. It has happened three times in this plan —
 * a `toBe(401)` that stayed green against broken code, a comparison against
 * `undefined`, and a 404 the handler produced for its own unrelated reason. The
 * two sentences are imported from the controller rather than typed out, so what
 * is compared is the branch and not a copy of its text.
 */
describe("changing your own password proves it is you", () => {
  it("demands the current one from somebody changing their own, and says which thing is missing", async () => {
    findOne.mockResolvedValue(storedUser().model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(400);
    // The message and not the number: the new password sent above is a valid
    // one precisely so that a 400 cannot be the policy talking.
    expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
  });

  /**
   * The break-it test of this task. Loosen the gate back to the permission and
   * this request answers 200, having changed the password of a live
   * administrator account with nothing but a session behind it.
   */
  it("demands it from an administrator changing their own, permission and all", async () => {
    const stored = storedUser({ id: ADMIN });
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(ADMIN) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
    // And the account was left exactly as it was: no hash written, no sessions
    // ended. A 400 that had already revoked something would be worse than a 200.
    expect(stored.save).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });

  it("refuses an empty string and a non-string the same way, rather than comparing them", async () => {
    // The old `if (oldPass)` treated every falsy value as "did not send one"
    // and fell through to the permission — which is the shape of the hole
    // itself. Refused before the comparison, the same way the rename refuses
    // them, so the two cannot disagree about what "sent nothing" means.
    const bcryptjs = (await import("bcryptjs")).default;
    for (const oldPass of ["", 0, false, null, undefined, { pass: "x" }]) {
      vi.clearAllMocks();
      can.mockImplementation(async (rol: number) => rol === ADMIN);
      const stored = storedUser();
      findOne.mockResolvedValue(stored.model);

      const c = call(
        { id: SELF, id_rol: TECNICO },
        { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass } },
      );
      await updateUserPass(c.req, c.res);

      expect(c.status, JSON.stringify(oldPass)).toBe(400);
      expect(c.message, JSON.stringify(oldPass)).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
      expect(bcryptjs.compare, JSON.stringify(oldPass)).not.toHaveBeenCalled();
      expect(stored.save, JSON.stringify(oldPass)).not.toHaveBeenCalled();
    }
  });

  it("refuses when the current one is wrong, and writes the attempt down", async () => {
    const { logAction } = await import("../utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "equivocada" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(401);
    expect(c.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
    expect(stored.save).not.toHaveBeenCalled();
    // Compared against the stored hash of the row already in hand, not against
    // whatever the body carried.
    expect(bcryptjs.compare).toHaveBeenCalledWith("equivocada", "hash-viejo");
    // A run of these on one account is somebody holding a session and guessing
    // at the password behind it — the event worth finding in the bitácora, and
    // the only thing that explains the 429 the budget will eventually answer.
    // Same action name `verifyOwnPassword` writes, so both doors read as one
    // event.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PASSWORD_CONFIRM_FAILED", severity: "warning" }),
    );
  });

  it("lets an administrator reset somebody else's without knowing it", async () => {
    // The control, and the reason the rule is not "always". An administrator
    // resets a password precisely because that person cannot get in, so there
    // is no current one for either of them to supply. This is what the
    // exemption exists for; it must keep working, and it is the one case that
    // stays green when the gate is deleted.
    const bcryptjs = (await import("bcryptjs")).default;
    const stored = storedUser({ id: OTHER });
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(stored.save).toHaveBeenCalled();
    // And nothing was compared, so no round trip and no oracle on a path where
    // there is no password anybody could be expected to know.
    expect(bcryptjs.compare).not.toHaveBeenCalled();
  });

  it("ignores an oldPass aimed at somebody else's account instead of comparing it", async () => {
    // Compared, it was checked against the *target's* hash: an unlimited
    // 401-or-not oracle against another person's password, for a caller who can
    // reset it outright anyway and would come away with the plaintext. Nothing
    // is given up by ignoring it — `seguridad.editar` is what authorises this
    // request, with or without a password on it.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const stored = storedUser({ id: OTHER });
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba", oldPass: "adivinando" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(bcryptjs.compare).not.toHaveBeenCalled();
  });

  /**
   * The comparator decision, pinned — and it is the reason there are two ways
   * of comparing a password in this controller.
   *
   * The rename uses `verifyOwnPassword`, which shares `checkAgainstRow` with
   * the login. That door **refuses a locked account before it compares
   * anything**, on purpose, so that confirming a password can never become a
   * way of lifting a lockout. Right there, wrong here: lifting the lockout is
   * what this write is *for*. `authenticate` does not read `locked_until`, so
   * somebody whose account was locked by another person grinding their username
   * still holds the session they had, and changing their password is their only
   * way out. Through the shared door they would be told their current password
   * is wrong while it was right, and that exit would close.
   */
  it("still lets a locked account change its own password, which is its way out", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const stored = storedUser({
      failed_attempts: LOCKOUT_AFTER_FAILURES,
      locked_until: new Date(Date.now() + 60_000),
    });
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "la-mia" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(written(stored.set)).toEqual({
      pass: "hashed",
      failed_attempts: 0,
      locked_until: null,
      pass_changed_at: expect.any(Date),
    });
    // Swap the comparison to `verifyOwnPassword` and this is what breaks: these
    // two assertions are the decision, since the shared door is mocked in this
    // file and would happily answer `ok` to a locked row it would refuse in
    // production.
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(bcryptjs.compare).toHaveBeenCalledWith("la-mia", "hash-viejo");
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
    expect(written(stored.set)).toEqual({
      pass: "hashed",
      failed_attempts: 0,
      locked_until: null,
      pass_changed_at: expect.any(Date),
    });
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
        { params: { id: String(SELF) }, body: { user: "Isaias", oldPass: "la-mia" } },
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
      // Pinned on the reason, because this handler now has *two* ways to answer
      // 400 — a username that is not a string, and a missing current password —
      // and the number alone no longer says which one ran. This is the first.
      expect(c.message).toMatch(/debe ser un texto/i);
      expect(c.message).not.toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
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
        { params: { id: String(SELF) }, body: { user: "otronombre", oldPass: "la-mia" } },
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
 * Nothing, until now. Changing a password — the thing you do precisely because
 * somebody else may know the old one — left every browser that knew it logged in
 * for up to thirty days. An administrator resetting the password of somebody who
 * has left the company was doing nothing whatsoever to the laptop in their bag.
 *
 * The belt over these braces is `usuarios.pass_changed_at`: `authenticate`
 * refuses any session opened before that stamp, whatever else is true about it.
 *
 * **There used to be an exception here and there is not any more.** Your own
 * session was spared, because otherwise changing your own password answered 200
 * and then refused your very next request — which reads as the change having
 * failed and invites doing it again. That problem is real and these tests still
 * cover it; what changed is the answer. The session is now **rotated**: every
 * row goes, including the caller's own, and a fresh one is opened in its place.
 *
 * Sparing a row and stamping the column cannot both be true — the spared
 * session is older than the stamp, so `authenticate` refuses it and the
 * exception survives in the source while being dead in fact. Rotating is what
 * lets the rule in `authenticate` keep having **no exceptions**, which is the
 * whole reason it is worth having.
 */
describe("a new password ends the old sessions", () => {
  const MI_SESION = "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa";

  it("ends every session including its own, and opens a fresh one in its place", async () => {
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);
    revokeAllSessionsOf.mockResolvedValue(2);

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    // No `except` key at all, not a key holding `undefined` — the same
    // assertion `password.controller.test.ts` makes for the same reason.
    const [id, opciones] = revokeAllSessionsOf.mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(SELF);
    expect(opciones).not.toHaveProperty("except");
    expect(issueSession).toHaveBeenCalledTimes(1);
  });

  it("stamps pass_changed_at in the same write as the hash", async () => {
    // Same write, so there is no instant in which the password is the new one
    // and the stamp still names the old. This is the write that makes the
    // rotation necessary — and the rotation is what makes it safe.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    const valores = written(stored.set);
    expect(valores.pass).toBe("hashed");
    expect(valores.pass_changed_at).toBeInstanceOf(Date);
  });

  it("opens the new session in the state the old one was in, not a fresh `completa`", async () => {
    // Read from the session rather than written as a literal. Today only
    // `completa` can reach this route — `sessionState.ts`'s allowlist opens
    // nothing outside `/api/auth/*` to the other two — so a hardcoded
    // "completa" would pass every other test in this file. If that allowlist
    // ever widens, a literal here would be a silent promotion: somebody
    // half-way through setting up their second factor changes their password
    // and lands in a session that has finished.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION, estado: "onboarding" },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(issueSession).toHaveBeenCalledWith(c.req, c.res, SELF, "onboarding");
  });

  it("answers 200, not 500, when the password changed but the new session could not be opened", async () => {
    // The one failure this handler must never report as a failure. The password
    // is already committed by this point; a 500 says "it did not work", and the
    // retry sends the same `oldPass`, which no longer matches the stored hash —
    // so the second attempt answers 401 "La contraseña actual suministrada no
    // es correcta" about a password that did in fact change. Losing the cookie
    // means logging in again with the new password, which works.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);
    issueSession.mockRejectedValue(new Error("no se pudo abrir la sesión nueva"));

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
  });

  it("rotates nothing of the administrator's own when they change somebody else's", async () => {
    // The rotation is about the caller's credential, and an administrator
    // resetting a leaver has not changed their own password. Opening a session
    // for them here would be minting a credential nobody asked for; opening one
    // for the *target* would be handing the administrator that person's
    // session.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN, id_sesion: MI_SESION },
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(issueSession).not.toHaveBeenCalled();
  });

  it("saves the hash and revokes inside one transaction", async () => {
    // Outside a transaction this endpoint had a failure mode that does not
    // repair itself. The save lands, the revocation fails, the caller gets a
    // 500 — and the retry is *worse*: the form sends the same `oldPass`, which
    // no longer matches the stored hash, so the second attempt answers 401 "La
    // contraseña actual suministrada no es correcta". Ana changes her password
    // because she thinks somebody knows it, the UPDATE on `sesiones` loses a
    // lock race against an export's `touchSession` writes, and she is told her
    // current password is wrong — while it has in fact changed and her old
    // sessions are alive for another week.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    // Both writes carrying the same transaction is the whole assertion: either
    // one outside it can commit on its own.
    expect(stored.save).toHaveBeenCalledWith({ transaction: TRANSACCION });
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(
      SELF,
      expect.objectContaining({ transaction: TRANSACCION }),
    );
  });

  it("answers 500 rather than leaving the password changed with the sessions alive", async () => {
    // The rollback itself is Sequelize's. What this pins is that the failure is
    // not swallowed and that the save was inside the transaction, which is what
    // makes the rollback possible at all.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);
    revokeAllSessionsOf.mockRejectedValue(new Error("lock timeout en sesiones"));

    const c = call(
      { id: SELF, id_rol: TECNICO, id_sesion: MI_SESION },
      { params: { id: String(SELF) }, body: { pass: "una-clave-de-prueba", oldPass: "vieja" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(500);
    expect(stored.save).toHaveBeenCalledWith({ transaction: TRANSACCION });
  });

  it("spares nothing when an administrator resets somebody else's", async () => {
    // The case the whole thing is for. Sparing anything here would be sparing a
    // session of the person being reset, chosen by an id belonging to the
    // administrator doing the resetting.
    //
    // This handler no longer passes `except` on any path — the caller's own
    // session is rotated rather than spared — so what used to be two branches
    // here is one call with no exception in it. The `except: undefined` route
    // into `revokeAllSessionsOf` is still covered, by `password.controller.ts`
    // and by `sessionStore.test.ts` directly; see the latter for why writing
    // that check the obvious way would revoke nothing at all.
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN, id_sesion: MI_SESION },
      { params: { id: String(OTHER) }, body: { pass: "una-clave-de-prueba" } },
    );
    await updateUserPass(c.req, c.res);

    expect(c.status).toBe(200);
    const [id, opciones] = revokeAllSessionsOf.mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(OTHER);
    expect(opciones).not.toHaveProperty("except");
    expect(opciones.transaction).toBe(TRANSACCION);
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
 * Archiving an account ends its sessions and its remembered devices, in the
 * same transaction.
 *
 * The `ON DELETE RESTRICT` on `sesiones.id_usuario` and on
 * `dispositivo_recordado.id_usuario` does nothing here and never will: this is a
 * soft delete, the row stays where it is with a `deletedAt` on it, and no
 * foreign key fires on an UPDATE. So archiving the technician who was let go
 * used to leave his laptop working until the session reached its own expiry —
 * up to thirty days — and, once remembered devices exist, would leave every
 * device cookie on that account intact for `desarchivarUsuario` to hand back
 * along with the account.
 *
 * One transaction because half of this is worse than none. Archived with live
 * sessions is the hole itself; sessions killed without the archive is an
 * account that looks fine to an administrator and cannot be used; and an
 * account archived whose devices still work looks closed on the screen and is
 * open in the field.
 */
describe("archiving an account ends its sessions and its remembered devices", () => {
  it("archives and revokes inside one transaction", async () => {
    revokeAllSessionsOf.mockResolvedValue(2);

    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) } });
    await deleteUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    // All three writes, and all three carrying the *same* transaction. Any of
    // them outside it would commit on its own, which is precisely the half-done
    // state this is meant to make impossible.
    expect(destroy).toHaveBeenCalledWith({ where: { id: String(OTHER) }, transaction: TRANSACCION });
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(OTHER, { transaction: TRANSACCION });
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(OTHER, { transaction: TRANSACCION });
  });

  it("revokes the remembered devices of the account it archives", async () => {
    // Nothing else in the system does this. The delete is logical, so no
    // cascade fires now or ever, and `authenticate` refusing an archived
    // account never reaches a device cookie — a remembered device is what lets
    // a login *skip* the factor, read before there is any session to refuse.
    // The archived stretch is covered anyway, because a paranoid `findOne`
    // cannot find the account to log in as; what is not covered is the undo.
    // Without this call, `desarchivarUsuario` hands the account back together
    // with every unexpired device cookie ever issued on it.
    const c = call({ id: ADMIN, id_rol: ADMIN }, { params: { id: String(OTHER) } });
    await deleteUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    // The account's own id, as a number — the same argument `revokeAllSessionsOf`
    // gets. Whose devices these are is this table's entire security property.
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(OTHER, expect.anything());
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

  it("answers 500 rather than archiving an account whose devices still skip the factor", async () => {
    // Same rule as the line above, for the write added after it. Swallowing
    // this one would answer 200 to an archive that left the leaver's laptop
    // able to skip the second factor — the worst of the three outcomes,
    // because it is the one that looks like success.
    revokeAllRememberedDevicesOf.mockRejectedValue(new Error("no se pudo revocar el dispositivo"));

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
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
  });
});


/**
 * Renaming your own account has to prove it is you, and the server is what
 * checks.
 *
 * The hole these tests close: `updateUserName` demanded nothing at all, while
 * `updateUserPass` right beside it had always demanded the current password of
 * anybody who could not manage accounts — and, it turned out, of nobody who
 * could, their own password included. That half is closed in "changing your own
 * password proves it is you" above; both handlers read one rule now.
 * The two operations are worth the same — a username is half the credential, so
 * whoever changes yours locks you out of your own account without ever knowing
 * your password — and one screen asked for a password it then never sent while
 * the other never asked at all. A confirmation that lives only in the client is
 * optional by definition.
 *
 * **Every assertion here names the reason and not only the number**, and that
 * is not decoration. This endpoint already answered 400 to a username that is
 * not a string and 409 to one in use, so a test reading the status alone can
 * pass through the wrong branch with the gate deleted. Earlier in this plan a
 * `toBe(401)` stayed green against broken code for exactly that reason. The two
 * sentences are imported from the controller rather than typed out, so what is
 * compared is the branch and not a copy of its text.
 */
describe("renaming your own account proves it is you", () => {
  it("refuses a self-rename that sends no password, and says which thing is missing", async () => {
    // The break-it test of this task on the server. Delete the block in
    // `updateUserName` and this request goes on to answer 200.
    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { user: "ana2" } },
    );
    await updateUserName(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
    // Nothing was compared and nothing was read: the refusal is decided from
    // the body, before any round trip.
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses an empty string and a non-string the same way, rather than comparing them", async () => {
    // An empty string is not a confirmation and a number is not a password.
    // Both are refused before the round trip, the same way `verifyOwnPassword`
    // refuses them, so the two cannot disagree about what "sent nothing" means.
    for (const oldPass of ["", 123, null, undefined, { pass: "x" }]) {
      vi.clearAllMocks();
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const c = call(
        { id: SELF, id_rol: TECNICO },
        { params: { id: String(SELF) }, body: { user: "ana2", oldPass } },
      );
      await updateUserName(c.req, c.res);

      expect(c.status, JSON.stringify(oldPass)).toBe(400);
      expect(c.message, JSON.stringify(oldPass)).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
      expect(verifyOwnPassword, JSON.stringify(oldPass)).not.toHaveBeenCalled();
    }
  });

  it("refuses a wrong password with 401 and writes nothing", async () => {
    verifyOwnPassword.mockResolvedValue({ ok: false, reason: "wrong-password" });
    const stored = storedUser();
    findOne.mockResolvedValue(stored.model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { user: "ana2", oldPass: "no-es-la-mia" } },
    );
    await updateUserName(c.req, c.res);

    expect(c.status).toBe(401);
    expect(c.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
    expect(stored.save).not.toHaveBeenCalled();
  });

  it("asks about the caller's own account, from the session and never from the body", async () => {
    // The id is taken off `req.user`. Read from `:id` it would be equal here
    // today and wrong the moment this block moves; read from the body it would
    // be whatever the caller cared to send.
    findOne.mockResolvedValue(null);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { user: "ana2", oldPass: "la-mia", id: OTHER } },
    );
    await updateUserName(c.req, c.res);

    expect(verifyOwnPassword).toHaveBeenCalledTimes(1);
    expect(verifyOwnPassword.mock.calls[0][0]).toMatchObject({ id: SELF, pass: "la-mia" });
  });

  /**
   * The decision this task had to make, pinned — and the one `updateUserPass`
   * has since been made to match.
   *
   * `seguridad.editar` may omit the current password when acting on *somebody
   * else*, and there it is right: an administrator resets a password precisely
   * because somebody cannot get in, so there is no current one for them to
   * know. Acting on *yourself* rescues nobody, so the exemption buys nothing —
   * and it would give up the check in the worst place, since an administrator's
   * unattended machine is the same attack with more reach.
   */
  it("demands it from an administrator renaming themselves, permission and all", async () => {
    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(ADMIN) }, body: { user: "root2" } },
    );
    await updateUserName(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("does not demand it from an administrator renaming somebody else", async () => {
    // The other half of the same decision, and the reason it is not "always".
    // `seguridad.editar` is what authorises acting on another account, and
    // there is no password the caller could be expected to know — the target's
    // is unknown to them by design.
    findOne.mockResolvedValueOnce(null);
    const stored = storedUser({ id: OTHER });
    findOne.mockResolvedValueOnce(stored.model);

    const c = call(
      { id: ADMIN, id_rol: ADMIN },
      { params: { id: String(OTHER) }, body: { user: "ana2" } },
    );
    await updateUserName(c.req, c.res);

    expect(c.status).toBe(200);
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(stored.save).toHaveBeenCalled();
  });

  it("checks the password before the collision, so an unproven caller learns nothing", async () => {
    // Ordering, asserted rather than assumed. With the gate placed after the
    // collision check this answers 409 and tells somebody who has not proved
    // who they are that `isaias` is taken.
    findOne.mockResolvedValueOnce(storedUser({ id: 3, user: "isaias" }).model);

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { user: "isaias" } },
    );
    await updateUserName(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("answers 404, not a wrong password, when the account went away mid-request", async () => {
    // Archived between `authenticate` and the check. Telling somebody their
    // password is wrong when it was right sends them hunting for a typo that
    // does not exist.
    verifyOwnPassword.mockResolvedValue({ ok: false, reason: "no-account" });

    const c = call(
      { id: SELF, id_rol: TECNICO },
      { params: { id: String(SELF) }, body: { user: "ana2", oldPass: "la-mia" } },
    );
    await updateUserName(c.req, c.res);

    // The 404 alone proves nothing here and that is the trap this plan keeps
    // hitting: with the gate deleted, `findOne` returns nothing and the handler
    // answers 404 for its own unrelated reason. What separates the two is that
    // the check ran at all.
    expect(verifyOwnPassword).toHaveBeenCalledTimes(1);
    expect(c.status).toBe(404);
    expect(c.message).not.toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
  });
});

/**
 * The rule on its own, because three things read it: both handlers that change
 * a credential, and the rate-limit mount in `usuario.routes.ts` which has to
 * charge exactly the requests that compare a password. One function so the
 * three cannot drift — and one argument, since "the exemption is for rescuing
 * somebody else" is the same sentence for a rename and for a password change.
 */
describe("requiresOwnPassword", () => {
  const req = (user: unknown, id: unknown) =>
    ({ user, params: { id } }) as unknown as Parameters<typeof requiresOwnPassword>[0];

  it("is true for your own account", () => {
    expect(requiresOwnPassword(req({ id: SELF, id_rol: TECNICO }, String(SELF)))).toBe(true);
  });

  it("is true for your own account even holding the permission", () => {
    expect(requiresOwnPassword(req({ id: ADMIN, id_rol: ADMIN }, String(ADMIN)))).toBe(true);
  });

  it("is false for somebody else's", () => {
    expect(requiresOwnPassword(req({ id: ADMIN, id_rol: ADMIN }, String(OTHER)))).toBe(false);
  });

  it("is false with no session, rather than throwing", () => {
    // Not reachable through the real mount — `authenticate` answers 401 first —
    // but this runs as middleware, and a guard that throws where it should
    // return is a 500 on a path that had a correct answer available.
    expect(requiresOwnPassword(req(undefined, String(SELF)))).toBe(false);
  });

  it("is false for an id that is not a number", () => {
    // `Number("ana")` is NaN and NaN equals nothing, this id included. The
    // handler's own guard reaches the same verdict, so such a request is a 403
    // rather than an unpaid pass through the budget.
    expect(requiresOwnPassword(req({ id: SELF, id_rol: TECNICO }, "ana"))).toBe(false);
  });
});
