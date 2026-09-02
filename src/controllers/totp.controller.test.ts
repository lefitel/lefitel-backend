// `totp.controller.ts` — the business rules behind `setup`, `confirm` and
// `delete`, tested with `requireStepUp` already assumed to have run (its own
// suite is `requireStepUp.test.ts`; the wiring that actually mounts it with
// `exigeContrasena: true` is `totp.routes.test.ts`'s job, not this file's).
//
// `otpauth` is used for real here, never mocked: it is deterministic given a
// secret and a timestamp, and a mock would just be reimplementing RFC 6238
// badly. `Date.now()` is frozen with fake timers wherever a test needs to
// control which time step a code belongs to.
//
// `call()`'s `status`/`payload` are getters over the fake `res`, read through
// the returned context object (`c.status`, never destructured up front) —
// destructuring them before the handler runs would freeze them at their
// initial values (`0`/`undefined`), which is exactly the mistake this file's
// first draft made and every test caught by simply staying red at `expect(0)`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { Secret, TOTP } from "otpauth";

const usuarioFindByPk = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => usuarioFindByPk(...a) },
}));

const factorFindOne = vi.fn();
const factorUpdate = vi.fn();
const factorDestroy = vi.fn();
vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: {
    update: (...a: unknown[]) => factorUpdate(...a),
    destroy: (...a: unknown[]) => factorDestroy(...a),
    // Matches the rest of the 4B codebase (`mfaKeyCheck.ts`,
    // `rotateMfaKey.ts`, `totpStore.ts`): every plain read of this model
    // goes through `.unscoped()` first.
    unscoped: () => ({ findOne: (...a: unknown[]) => factorFindOne(...a) }),
  },
}));

const guardarSecretoSinConfirmar = vi.fn();
const leerSecretoSinConfirmar = vi.fn();
const confirmarFactor = vi.fn();
vi.mock("../auth/totpStore.js", () => ({
  guardarSecretoSinConfirmar: (...a: unknown[]) => guardarSecretoSinConfirmar(...a),
  leerSecretoSinConfirmar: (...a: unknown[]) => leerSecretoSinConfirmar(...a),
  confirmarFactor: (...a: unknown[]) => confirmarFactor(...a),
}));

const promoverSesion = vi.fn();
const apagarLaMecha = vi.fn();
vi.mock("../auth/sessionPromotion.js", () => ({
  promoverSesion: (...a: unknown[]) => promoverSesion(...a),
  apagarLaMecha: (...a: unknown[]) => apagarLaMecha(...a),
}));

const tieneAlgunFactor = vi.fn();
vi.mock("../auth/factorInventory.js", () => ({
  tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactor(...a),
}));

const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("../auth/rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...a: unknown[]) => revokeAllRememberedDevicesOf(...a),
}));

const logAction = vi.fn();
// The four writes that finish a registration now share one transaction — see
// `confirmTotp`'s own comment for the in-between states that motivated it. The
// fake runs the callback straight through with a marker object, so every write
// below can be asserted to have carried it.
const TRANSACCION = { LOCK: "fake" };
const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(TRANSACCION));
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...args: unknown[]) => transaction(...(args as [never])) },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));

vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  setupTotp,
  confirmTotp,
  deleteTotp,
  MENSAJE_CORREO_NO_VERIFICADO,
  MENSAJE_FACTOR_YA_CONFIGURADO,
  MENSAJE_CODIGO_REQUERIDO,
  MENSAJE_SIN_SETUP_PENDIENTE,
  MENSAJE_CODIGO_INCORRECTO,
  MENSAJE_FACTOR_CONFIRMADO,
  MENSAJE_SIN_FACTOR,
  MENSAJE_FACTOR_ELIMINADO,
} = await import("./totp.controller.js");

const CALLER = {
  id: 7,
  id_rol: 2,
  id_sesion: "sesion-7",
  expires_at: new Date("2026-09-15T00:00:00Z"),
  estado: "completa" as const,
  mfa_satisfied_at: new Date("2026-09-01T00:00:00Z"),
};

function usuarioRow(overrides: Record<string, unknown> = {}) {
  return {
    dataValues: {
      id: CALLER.id,
      user: "tester",
      email_verified_at: new Date("2026-08-01T00:00:00Z"),
      ...overrides,
    },
  };
}

function call(user: NonNullable<Request["user"]> | undefined, body: unknown = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return {
    req: { user, body, ip: "203.0.113.9", originalUrl: "/api/auth/totp/x" } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as { message?: string; secreto?: string; otpauth?: string };
    },
  };
}

beforeEach(() => {
  usuarioFindByPk.mockReset().mockResolvedValue(usuarioRow());
  factorFindOne.mockReset().mockResolvedValue(null);
  factorUpdate.mockReset().mockResolvedValue([1]);
  factorDestroy.mockReset().mockResolvedValue(1);
  guardarSecretoSinConfirmar.mockReset().mockResolvedValue({ id: 55 });
  leerSecretoSinConfirmar.mockReset().mockResolvedValue(null);
  confirmarFactor.mockReset().mockResolvedValue(undefined);
  promoverSesion.mockReset().mockResolvedValue(true);
  apagarLaMecha.mockReset().mockResolvedValue(undefined);
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  revokeAllRememberedDevicesOf.mockReset().mockResolvedValue(0);
  logAction.mockReset();
});

describe("setupTotp", () => {
  it("refuses when the account has no verified email (Decision 5)", async () => {
    usuarioFindByPk.mockResolvedValue(usuarioRow({ email_verified_at: null }));
    const c = call(CALLER);

    await setupTotp(c.req, c.res);

    expect(c.status).toBe(409);
    expect(c.payload.message).toBe(MENSAJE_CORREO_NO_VERIFICADO);
    expect(factorFindOne).not.toHaveBeenCalled();
    expect(guardarSecretoSinConfirmar).not.toHaveBeenCalled();
  });

  it("answers 409 when a confirmed factor already exists, and writes nothing (hallazgo C11)", async () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 99 } });
    const c = call(CALLER);

    await setupTotp(c.req, c.res);

    expect(c.status).toBe(409);
    expect(c.payload.message).toBe(MENSAJE_FACTOR_YA_CONFIGURADO);
    expect(guardarSecretoSinConfirmar).not.toHaveBeenCalled();
  });

  it("looks up the confirmed-factor check by the caller's own id, never the body", async () => {
    const c = call(CALLER, { id_usuario: 999999 });
    await setupTotp(c.req, c.res);
    expect(factorFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id_usuario: CALLER.id }) }),
    );
  });

  it("generates a fresh secret on every call and returns it with the otpauth URI in the body", async () => {
    const first = call(CALLER);
    await setupTotp(first.req, first.res);
    expect(first.status).toBe(200);
    expect(guardarSecretoSinConfirmar).toHaveBeenCalledTimes(1);
    const secretoUno = guardarSecretoSinConfirmar.mock.calls[0][1] as string;
    expect(first.payload.secreto).toBe(secretoUno);
    expect(first.payload.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect(first.payload.otpauth).toContain("Osefi");

    const second = call(CALLER);
    await setupTotp(second.req, second.res);
    const secretoDos = guardarSecretoSinConfirmar.mock.calls[1][1] as string;

    // 🔴 The whole point of this assertion: a `setup` that cached or reused a
    // secret across calls would still return 200 with *some* base32 string,
    // so only comparing the two calls' arguments catches it.
    expect(secretoDos).not.toBe(secretoUno);
  });

  it("never writes to a query string or a redirect — the secret only ever reaches res.json", async () => {
    const c = call(CALLER);
    const redirectSpy = vi.fn();
    (c.res as unknown as { redirect: typeof redirectSpy }).redirect = redirectSpy;

    await setupTotp(c.req, c.res);

    expect(c.payload.secreto).toBeTruthy();
    expect(c.payload.otpauth).toBeTruthy();
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});

describe("confirmTotp", () => {
  const FIXED_NOW = new Date("2026-09-10T12:00:30.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function secretoDeFila(): { secret: Secret; base32: string } {
    const secret = new Secret({ size: 20 });
    return { secret, base32: secret.base32 };
  }

  it("requires a non-empty code before reading anything", async () => {
    const c = call(CALLER, {});
    await confirmTotp(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.payload.message).toBe(MENSAJE_CODIGO_REQUERIDO);
    expect(leerSecretoSinConfirmar).not.toHaveBeenCalled();
  });

  it("answers 400 when there is no pending setup for this account", async () => {
    leerSecretoSinConfirmar.mockResolvedValue(null);
    const c = call(CALLER, { codigo: "123456" });
    await confirmTotp(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.payload.message).toBe(MENSAJE_SIN_SETUP_PENDIENTE);
  });

  it("rejects a code that does not match, and writes nothing", async () => {
    const { base32 } = secretoDeFila();
    leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });
    const c = call(CALLER, { codigo: "000000" });

    await confirmTotp(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.payload.message).toBe(MENSAJE_CODIGO_INCORRECTO);
    expect(factorUpdate).not.toHaveBeenCalled();
    expect(confirmarFactor).not.toHaveBeenCalled();
    expect(promoverSesion).not.toHaveBeenCalled();
    expect(apagarLaMecha).not.toHaveBeenCalled();
  });

  it("confirms against the row's own secret, never one sent in the body (hallazgo C15) — red demonstration", async () => {
    const filaSecret = secretoDeFila();
    const cuerpoSecret = secretoDeFila();
    leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: filaSecret.base32 });

    // A code valid for the *body's* secret and nothing else. If the handler
    // ever read `req.body.secreto` instead of the row's, this would be
    // accepted; reading the row's secret, it must not be.
    const codigoDelCuerpo = TOTP.generate({
      secret: cuerpoSecret.secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      timestamp: FIXED_NOW,
    });
    const soloCuerpo = call(CALLER, { codigo: codigoDelCuerpo, secreto: cuerpoSecret.base32 });
    await confirmTotp(soloCuerpo.req, soloCuerpo.res);
    expect(soloCuerpo.status).toBe(400);
    expect(soloCuerpo.payload.message).toBe(MENSAJE_CODIGO_INCORRECTO);

    // The row's own code, with a *different* secret sitting in the body.
    // Succeeding here alongside the rejection above is what proves the body
    // is never consulted either way.
    const codigoDeFila = TOTP.generate({
      secret: filaSecret.secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      timestamp: FIXED_NOW,
    });
    const conFilaCorrecta = call(CALLER, { codigo: codigoDeFila, secreto: cuerpoSecret.base32 });
    await confirmTotp(conFilaCorrecta.req, conFilaCorrecta.res);
    expect(conFilaCorrecta.status).toBe(200);
  });

  it("seals the step that actually matched, not the step at the server's clock (hallazgo C10)", async () => {
    const { secret, base32 } = secretoDeFila();
    leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });

    const pasoActual = TOTP.counter({ period: 30, timestamp: FIXED_NOW });
    // A code for the *previous* step (delta === -1), not the current one.
    const codigoPasoAnterior = TOTP.generate({
      secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      timestamp: FIXED_NOW - 30_000,
    });
    const c = call(CALLER, { codigo: codigoPasoAnterior });

    await confirmTotp(c.req, c.res);

    expect(c.status).toBe(200);
    // 🔴 Sealing `pasoActual` instead of `pasoActual - 1` is exactly the bug
    // this test exists to catch: it would leave the accepted step's own
    // neighbour still open to replay. Confirmed by mutation while building
    // this task — see the O-report.
    expect(confirmarFactor).toHaveBeenCalledWith(55, BigInt(pasoActual) - 1n, {
      transaction: TRANSACCION,
    });
  });

  it("promotes the session that proved the factor (Task 5, Decision 8)", async () => {
    const { secret, base32 } = secretoDeFila();
    leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });
    const codigo = TOTP.generate({ secret, algorithm: "SHA1", digits: 6, period: 30, timestamp: FIXED_NOW });
    const c = call(CALLER, { codigo });

    await confirmTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(promoverSesion).toHaveBeenCalledWith(CALLER.id_sesion, "totp", {
      transaction: TRANSACCION,
    });
  });

  it("clears the fourteen-day grace deadline on confirm", async () => {
    const { secret, base32 } = secretoDeFila();
    leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });
    const codigo = TOTP.generate({ secret, algorithm: "SHA1", digits: 6, period: 30, timestamp: FIXED_NOW });
    const c = call(CALLER, { codigo });

    await confirmTotp(c.req, c.res);

    expect(apagarLaMecha).toHaveBeenCalledWith(CALLER.id, { transaction: TRANSACCION });
  });

  it("marks the row confirmed and writes a critical bitácora line", async () => {
    const { secret, base32 } = secretoDeFila();
    leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });
    const codigo = TOTP.generate({ secret, algorithm: "SHA1", digits: 6, period: 30, timestamp: FIXED_NOW });
    const c = call(CALLER, { codigo });

    await confirmTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload.message).toBe(MENSAJE_FACTOR_CONFIRMADO);
    // Through `confirmarFactor`, not a bare `FactorTotpModel.update`: marking
    // the row confirmed and sealing the step it was proved with are one
    // statement now, because between two of them the row is confirmed with no
    // step sealed and the code that just registered the factor is still
    // acceptable to a concurrent verify.
    expect(confirmarFactor).toHaveBeenCalledWith(55, expect.any(BigInt), {
      transaction: TRANSACCION,
    });
    expect(factorUpdate).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ id_usuario: CALLER.id, severity: "critical", action: "TOTP_CONFIRMED" }),
    );
  });
});

describe("deleteTotp", () => {
  it("answers 404 when the account has no factor at all", async () => {
    factorFindOne.mockResolvedValue(null);
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.status).toBe(404);
    expect(c.payload.message).toBe(MENSAJE_SIN_FACTOR);
    expect(factorDestroy).not.toHaveBeenCalled();
  });

  it("deletes an unconfirmed row without treating it as the loss of a factor (hallazgo C11 tail)", async () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 10, confirmed_at: null } });
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload.message).toBe(MENSAJE_FACTOR_ELIMINADO);
    expect(factorDestroy).toHaveBeenCalledWith({ where: { id_usuario: CALLER.id } });
    // 🔴 The load-bearing assertions: a row that was never confirmed never
    // counted as a factor, so its removal must not ask whether one remains,
    // and must not revoke anything that removing a real factor would.
    expect(tieneAlgunFactor).not.toHaveBeenCalled();
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "info", action: "TOTP_SETUP_DISCARDED" }),
    );
  });

  it("deletes a confirmed row, and both revokes remembered devices and logs critical when none remain", async () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 11, confirmed_at: new Date() } });
    tieneAlgunFactor.mockResolvedValue(false);
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(factorDestroy).toHaveBeenCalledWith({ where: { id_usuario: CALLER.id } });
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(CALLER.id);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        action: "TOTP_DELETED",
        metadata: expect.objectContaining({ ultimo_factor: true }),
      }),
    );
  });

  it("does not revoke devices or log critical when another factor remains on the account", async () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 12, confirmed_at: new Date() } });
    tieneAlgunFactor.mockResolvedValue(true);
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        action: "TOTP_DELETED",
        metadata: expect.objectContaining({ ultimo_factor: false }),
      }),
    );
  });
});
