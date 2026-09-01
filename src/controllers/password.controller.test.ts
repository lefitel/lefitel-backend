// Recovering access to an account you cannot log into.
//
// Three properties this file exists to pin harder than the rest, per
// `task-5-brief.md`'s acceptance criteria:
//
// - `/password/forgot` answers the exact same body, in the exact same
//   status, whether or not an account exists — and it does so *before* the
//   database lookup that would tell the two cases apart even resolves. A
//   test that only compares the two final bodies would pass against a
//   version that awaited the lookup first and still happened to answer the
//   same JSON slower on one branch; the ordering test below is what a
//   wall-clock measurement in CI cannot be trusted to catch reliably.
// - `/password/reset` writes to the account `consumirToken` names, never to
//   an `id` or `email` the body carries — the two-account red demonstration
//   `task-5-brief.md` asks for by name (spec §10).
// - A locked account leaves its lockout through this door. Removing
//   `locked_until: null` from the write is the second red demonstration the
//   brief asks for; the failing transcript is pasted in `task-5-report.md`,
//   not duplicated here as a skipped test.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";
import type { Request, Response } from "express";

const findOne = vi.fn();
const update = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...a: unknown[]) => findOne(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

const TRANSACCION = { id: "una-transaccion" };
const transaction = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...a: unknown[]) => transaction(...a) },
}));

const crearToken = vi.fn();
const consumirToken = vi.fn();
vi.mock("../auth/tokenStore.js", () => ({
  crearToken: (...a: unknown[]) => crearToken(...a),
  consumirToken: (...a: unknown[]) => consumirToken(...a),
}));

const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));
// `/password/reset` is the "somebody else knows my password" door, so it has
// to cut off remembered devices the same way it cuts off sessions — see the
// call site's own comment. Mocked for the same reason the store above is: the
// real module imports `dispositivoRecordado.model.ts`, which calls
// `UsuarioModel.hasMany` on the plain object standing in for the model here.
const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("../auth/rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...a: unknown[]) => revokeAllRememberedDevicesOf(...a),
}));

const enviarCorreo = vi.fn();
vi.mock("../auth/mailer.js", () => ({
  enviarCorreo: (...a: unknown[]) => enviarCorreo(...a),
}));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));

const loggerError = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn: vi.fn(), info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), debug: vi.fn() }),
}));

/**
 * `bcryptjs.hash` mocked, not real. A real cost-12 hash is ~250ms, and this
 * file runs it on every non-trivial `/password/reset` test — real bcrypt
 * here would not test anything a mock can't, it would just make the suite
 * slow. `validarPassword` (from `utils/password.js`) is *not* mocked: it is
 * a pure function with no side effects, and using the real 12-character
 * rule is what lets a test below prove the length check runs before this
 * mock is ever touched.
 */
const bcryptHash = vi.fn();
vi.mock("bcryptjs", () => ({
  default: { hash: (...a: unknown[]) => bcryptHash(...a) },
}));

const {
  forgotPassword,
  resetPassword,
  EMAIL_INVALIDO,
  PASSWORD_FORGOT_RESPUESTA,
  DATOS_RESET_REQUERIDOS,
  TOKEN_INVALIDO,
} = await import("./password.controller.js");
const { PASSWORD_MIN_LENGTH } = await import("../config/security.js");

const A = 7;
const TOKEN_CRUDO = "un-token-opaco-que-nunca-debe-salir-en-un-log";
const CLAVE_VALIDA = "una-contraseña-larga-y-valida-9";

function usuarioRow(overrides: Record<string, unknown> = {}) {
  return { dataValues: { id: A, email: "a@osefi.net", ...overrides } };
}

function call(body: unknown = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
  };
  return {
    req: { body, ip: "203.0.113.9", originalUrl: "/api/auth/password/x" } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as Record<string, unknown> | undefined;
    },
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
  };
}

/**
 * Everything mocked here resolves through the microtask queue only — no
 * real timers, no real I/O — so a single `setImmediate` (which fires after
 * every pending microtask has drained) is enough to let a whole chain of
 * mocked `await`s finish. Same pattern as `loginLimiters.test.ts`'s own
 * `settled()`, for the same reason: waiting on an unawaited tail.
 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(null);
  update.mockResolvedValue([1]);
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
  crearToken.mockResolvedValue(TOKEN_CRUDO);
  consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
  revokeAllSessionsOf.mockResolvedValue(1);
  revokeAllRememberedDevicesOf.mockResolvedValue(0);
  enviarCorreo.mockResolvedValue({ ok: true });
  bcryptHash.mockResolvedValue("$2a$12$hasheada");
});

describe("POST /auth/password/forgot", () => {
  it("refuses a body with no email at all — the global-constraints.md #13 test", async () => {
    const c = call({});
    await forgotPassword(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses a string that is not shaped like an email", async () => {
    const c = call({ email: "no-es-un-correo" });
    await forgotPassword(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses a non-string email without crashing", async () => {
    const c = call({ email: 12345 });
    await forgotPassword(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
  });

  /**
   * The strongest form of "responds before it does any work": the account
   * lookup is made to hang, and the assertion runs *while it is still
   * pending*. A version that awaited the lookup before responding would
   * leave `c.status` at 0 here — this is not a timing measurement, which
   * would be flaky under CI load, it is a fact about which promise resolved
   * first.
   */
  it("sends its response before the account lookup even resolves", async () => {
    let resolverBusqueda!: (v: unknown) => void;
    findOne.mockReturnValue(new Promise((resolve) => { resolverBusqueda = resolve; }));
    const c = call({ email: "a@osefi.net" });

    const hecho = forgotPassword(c.req, c.res);
    // Let the handler run up to (and past) `res.status(200).json(...)`,
    // without letting the lookup it started settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(c.status).toBe(200);
    expect(c.payload).toEqual({ message: PASSWORD_FORGOT_RESPUESTA });
    expect(findOne).toHaveBeenCalledOnce();
    // And the work behind the response has not gone anywhere yet — proof
    // that the 200 above did not wait for it.
    expect(crearToken).not.toHaveBeenCalled();
    expect(enviarCorreo).not.toHaveBeenCalled();

    resolverBusqueda(usuarioRow());
    await hecho;
    await settled();
    expect(crearToken).toHaveBeenCalledOnce();
  });

  it("answers the exact same body, in the exact same status, whether or not an account exists", async () => {
    findOne.mockResolvedValue(null);
    const sinCuenta = call({ email: "nadie@osefi.net" });
    await forgotPassword(sinCuenta.req, sinCuenta.res);
    await settled();

    vi.clearAllMocks();
    findOne.mockResolvedValue(usuarioRow());
    crearToken.mockResolvedValue(TOKEN_CRUDO);
    enviarCorreo.mockResolvedValue({ ok: true });
    const conCuenta = call({ email: "a@osefi.net" });
    await forgotPassword(conCuenta.req, conCuenta.res);
    await settled();

    expect(sinCuenta.status).toBe(conCuenta.status);
    expect(sinCuenta.payload).toEqual(conCuenta.payload);
    expect(sinCuenta.payload).toEqual({ message: PASSWORD_FORGOT_RESPUESTA });
  });

  it("answers the same body when Resend itself fails, per Global Constraint #1", async () => {
    findOne.mockResolvedValue(usuarioRow());
    enviarCorreo.mockResolvedValue({ ok: false });
    const c = call({ email: "a@osefi.net" });
    await forgotPassword(c.req, c.res);
    await settled();

    expect(c.status).toBe(200);
    expect(c.payload).toEqual({ message: PASSWORD_FORGOT_RESPUESTA });
  });

  it("queries only verified, non-null-email accounts — Global Constraint #8", async () => {
    const c = call({ email: "a@osefi.net" });
    await forgotPassword(c.req, c.res);
    await settled();

    const [options] = findOne.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(options.where).toEqual({ email: "a@osefi.net", email_verified_at: { [Op.ne]: null } });
  });

  it("mints a reset_password token and mails the reset link, only when an account was found", async () => {
    findOne.mockResolvedValue(usuarioRow());
    const c = call({ email: "  A@Osefi.NET  " });
    await forgotPassword(c.req, c.res);
    await settled();

    expect(crearToken).toHaveBeenCalledWith(
      expect.objectContaining({ id_usuario: A, email_destino: "a@osefi.net", proposito: "reset_password" }),
    );
    expect(enviarCorreo.mock.calls[0][0]).toMatchObject({ para: "a@osefi.net" });
  });

  it("normalizes (trims and lowercases) the address before querying", async () => {
    const c = call({ email: "  A@Osefi.NET  " });
    await forgotPassword(c.req, c.res);
    await settled();

    const [options] = findOne.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(options.where.email).toBe("a@osefi.net");
  });

  it("logs PASSWORD_FORGOT only when the account existed — bitacoras.id_usuario is NOT NULL", async () => {
    findOne.mockResolvedValue(usuarioRow());
    const c = call({ email: "a@osefi.net" });
    await forgotPassword(c.req, c.res);
    await settled();

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ id_usuario: A, action: "PASSWORD_FORGOT", severity: "info" }),
    );
  });

  it("writes no bitácora line at all for an address with no matching account", async () => {
    findOne.mockResolvedValue(null);
    const c = call({ email: "nadie@osefi.net" });
    await forgotPassword(c.req, c.res);
    await settled();

    expect(logAction).not.toHaveBeenCalled();
  });

  it("logs and swallows a failure in the background work, without ever touching the response again", async () => {
    findOne.mockResolvedValue(usuarioRow());
    crearToken.mockRejectedValue(new Error("insert falló"));
    const c = call({ email: "a@osefi.net" });
    await forgotPassword(c.req, c.res);
    await settled();

    // The response the client already has, unmoved by the failure.
    expect(c.status).toBe(200);
    expect(c.payload).toEqual({ message: PASSWORD_FORGOT_RESPUESTA });
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining("/password/forgot"),
    );
  });

  it("never puts the plain token in the response or in a bitácora line", async () => {
    findOne.mockResolvedValue(usuarioRow());
    crearToken.mockResolvedValue(TOKEN_CRUDO);
    const c = call({ email: "a@osefi.net" });
    await forgotPassword(c.req, c.res);
    await settled();

    expect(JSON.stringify(c.payload)).not.toContain(TOKEN_CRUDO);
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(TOKEN_CRUDO);
  });
});

describe("POST /auth/password/reset", () => {
  it("refuses a body with neither field — the global-constraints.md #13 test", async () => {
    const c = call({});
    await resetPassword(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(DATOS_RESET_REQUERIDOS);
    expect(consumirToken).not.toHaveBeenCalled();
    expect(bcryptHash).not.toHaveBeenCalled();
  });

  it("refuses a token with no password, and vice versa, before touching anything", async () => {
    const soloToken = call({ token: "un-token" });
    await resetPassword(soloToken.req, soloToken.res);
    expect(soloToken.status).toBe(400);
    expect(soloToken.message).toBe(DATOS_RESET_REQUERIDOS);

    const soloPass = call({ pass: CLAVE_VALIDA });
    await resetPassword(soloPass.req, soloPass.res);
    expect(soloPass.status).toBe(400);
    expect(soloPass.message).toBe(DATOS_RESET_REQUERIDOS);

    expect(consumirToken).not.toHaveBeenCalled();
  });

  it("validates the new password before bcrypt or any database call — the CPU-exhaustion defense", async () => {
    const c = call({ token: "un-token", pass: "corta" });
    await resetPassword(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
    expect(bcryptHash).not.toHaveBeenCalled();
    expect(consumirToken).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("hashes with bcrypt before the transaction opens, unconditionally on a valid-shaped password", async () => {
    // Deliberately a token that will not redeem: the hash still has to run,
    // because by the time the transaction opens it is too late to avoid —
    // see the comment on `resetPassword` for why this is the accepted cost.
    consumirToken.mockResolvedValue(null);
    const orden: string[] = [];
    bcryptHash.mockImplementation(async () => {
      orden.push("hash");
      return "$2a$12$hasheada";
    });
    transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => {
      orden.push("transaction-abierta");
      return fn(TRANSACCION);
    });
    const c = call({ token: "un-token-cualquiera", pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    expect(orden).toEqual(["hash", "transaction-abierta"]);
  });

  it("answers TOKEN_INVALIDO and writes nothing when the token does not redeem", async () => {
    consumirToken.mockResolvedValue(null);
    const c = call({ token: "caducado-o-usado-o-inventado", pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(TOKEN_INVALIDO);
    expect(update).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("redeems inside the same transaction it writes in, passed through explicitly", async () => {
    const c = call({ token: "un-token", pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    expect(consumirToken).toHaveBeenCalledWith("un-token", "reset_password", { transaction: TRANSACCION });
    const [, options] = update.mock.calls[0] as [unknown, { transaction: unknown }];
    expect(options.transaction).toBe(TRANSACCION);
    expect(revokeAllSessionsOf.mock.calls[0][1]).toMatchObject({ transaction: TRANSACCION });
  });

  it("writes the new hash, clears the lockout, and revokes every session with no `except` — all together", async () => {
    const c = call({ token: "un-token", pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    expect(c.status).toBe(200);
    const [values, options] = update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(values).toMatchObject({ pass: "$2a$12$hasheada", failed_attempts: 0, locked_until: null });
    expect(options.where).toEqual({ id: A });

    const [id, revokeOptions] = revokeAllSessionsOf.mock.calls[0] as [number, { except?: string }];
    expect(id).toBe(A);
    // Not merely absent from an object that happens to have no key — this
    // is the exact call `revokeAllSessionsOf`'s own comment says means
    // "spare nothing": no `except` key at all, so its `options.except` is
    // `undefined`, which is what turns the `where` into "every live session
    // of this account" rather than accidentally excluding none of them for
    // a different reason.
    expect(revokeOptions).not.toHaveProperty("except");
  });

  it("does not create a session and does not touch a cookie — returns to the login screen", async () => {
    const c = call({ token: "un-token", pass: CLAVE_VALIDA });
    (c.res as unknown as { cookie: () => void }).cookie = () => {
      throw new Error("resetPassword must not set a cookie");
    };
    await resetPassword(c.req, c.res);

    expect(c.status).toBe(200);
  });

  it("logs PASSWORD_RESET as critical, with the token's own address and no plain token", async () => {
    const crudo = "el-token-en-claro-de-esta-peticion";
    const c = call({ token: crudo, pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: A,
        action: "PASSWORD_RESET",
        severity: "critical",
        metadata: { email_destino: "a@osefi.net" },
      }),
    );
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(crudo);
    expect(JSON.stringify(c.payload)).not.toContain(crudo);
  });

  /**
   * The red demonstration `task-5-brief.md` asks for by name (spec §10):
   * "el token de A no resetea a B". Green today because the account written
   * is `redeemed.id_usuario`, never anything the body carries — demonstrated
   * by breaking it: in `password.controller.ts`'s `resetPassword`, change
   * `result.id_usuario` to `(req.body as { id?: number }).id ?? result.id_usuario`
   * in the `UsuarioModel.update` and `revokeAllSessionsOf` calls, then run
   * `npx vitest run src/controllers/password.controller.test.ts` — this test
   * goes red because the write lands on 999 instead of A. See
   * `task-5-report.md` for the pasted failure.
   */
  it("ignores an id and email in the body that point at another account", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    const c = call({
      token: "un-token-valido",
      pass: CLAVE_VALIDA,
      id: 999,
      id_usuario: 999,
      email: "attacker@evil.com",
    });
    await resetPassword(c.req, c.res);

    expect(c.status).toBe(200);
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toEqual({ id: A });
    expect(revokeAllSessionsOf.mock.calls[0][0]).toBe(A);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ id_usuario: A }));
  });

  /**
   * The other red demonstration the brief asks for by name: a locked
   * account has to leave the lockout through this door. Demonstrated by
   * breaking it: delete `locked_until: null` (leaving `failed_attempts: 0`)
   * from the `UsuarioModel.update` call in `resetPassword`, then run this
   * file — this test goes red because the written values no longer clear
   * the lockout. See `task-5-report.md` for the pasted failure.
   */
  it("clears failed_attempts and locked_until on a previously locked account", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    const c = call({ token: "un-token", pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    const [values] = update.mock.calls[0] as [Record<string, unknown>];
    expect(values.failed_attempts).toBe(0);
    expect(values.locked_until).toBeNull();
  });

  /**
   * The stamp `authenticate` reads, written in the same UPDATE as the hash.
   *
   * `revokeAllSessionsOf` two lines below already ends every session of this
   * account, so nothing here depends on this column to be safe today. It is
   * the second, independent answer: the day somebody adds a third door that
   * changes a password and forgets to revoke, this is what still refuses the
   * sessions that knew the old one.
   *
   * Same UPDATE and not a second one, so there is no order in which the
   * password is new and the stamp is not.
   */
  it("stamps pass_changed_at in the same write as the new hash", async () => {
    const c = call({ token: "un-token", pass: CLAVE_VALIDA });
    await resetPassword(c.req, c.res);

    const [values] = update.mock.calls[0] as [Record<string, unknown>];
    expect(values.pass).toBe("$2a$12$hasheada");
    expect(values.pass_changed_at).toBeInstanceOf(Date);
  });

  /**
   * `/password/reset` is the literal "somebody else has my password" door —
   * closing every session but leaving a remembered-device cookie standing
   * would let that same somebody's browser skip the second factor on the
   * very next login, on the password that was just supposedly taken away
   * from them. Specification finding, not covered until now.
   */
  describe("also cuts off every remembered device", () => {
    it("revokes the account the token names, inside the same transaction", async () => {
      consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
      const c = call({ token: "un-token", pass: CLAVE_VALIDA });
      await resetPassword(c.req, c.res);

      expect(c.status).toBe(200);
      // The account the *token* names, not an id `vi.fn().mockResolvedValue`
      // would accept blindly — the same property the "ignores an id and
      // email" test above pins for the sessions call.
      expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(A, { transaction: TRANSACCION });
    });

    it("ignores an id and email in the body that point at another account", async () => {
      consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
      const c = call({
        token: "un-token-valido",
        pass: CLAVE_VALIDA,
        id: 999,
        id_usuario: 999,
        email: "attacker@evil.com",
      });
      await resetPassword(c.req, c.res);

      expect(revokeAllRememberedDevicesOf.mock.calls[0][0]).toBe(A);
    });

    it("rolls the whole reset back — new password included — rather than leave a device cookie live", async () => {
      // All four writes commit together or none do: `consumirToken`'s own
      // comment already argues for the token redemption sharing this
      // transaction with the rest, for the same reason. A reset that
      // "succeeded" but left a device able to skip the factor is worse than
      // one that visibly failed and can be retried with the same link.
      revokeAllRememberedDevicesOf.mockRejectedValue(new Error("no se pudo revocar el dispositivo"));
      const c = call({ token: "un-token", pass: CLAVE_VALIDA });
      await resetPassword(c.req, c.res);

      expect(c.status).toBe(500);
      expect(logAction).not.toHaveBeenCalled();
    });
  });
});
