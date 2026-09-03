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
const sellarPruebaDeFactor = vi.fn();
const apagarLaMecha = vi.fn();
vi.mock("../auth/sessionPromotion.js", () => ({
  promoverSesion: (...a: unknown[]) => promoverSesion(...a),
  sellarPruebaDeFactor: (...a: unknown[]) => sellarPruebaDeFactor(...a),
  apagarLaMecha: (...a: unknown[]) => apagarLaMecha(...a),
}));

// Plan 4E: two questions. `tieneCredencialRegistrada` (a passkey or an app
// left) decides the remembered devices and the verb; `tieneAlgunFactor`
// (which a verified address now satisfies) decides the sessions. Mocked
// separately, so a tail keyed on the wrong one goes red.
const tieneAlgunFactor = vi.fn();
const tieneCredencialRegistrada = vi.fn();
vi.mock("../auth/factorInventory.js", () => ({
  tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactor(...a),
  tieneCredencialRegistrada: (...a: unknown[]) => tieneCredencialRegistrada(...a),
}));

const contarCodigosRestantes = vi.fn();
const prepararCodigos = vi.fn();
const escribirCodigos = vi.fn();
vi.mock("../auth/recoveryCodeStore.js", () => ({
  contarCodigosRestantes: (...a: unknown[]) => contarCodigosRestantes(...a),
  prepararCodigos: (...a: unknown[]) => prepararCodigos(...a),
  escribirCodigos: (...a: unknown[]) => escribirCodigos(...a),
}));

const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("../auth/rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...a: unknown[]) => revokeAllRememberedDevicesOf(...a),
}));

const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));
// Added with plan 4C's Task 9: the last-factor branch now clears the cookie,
// and the fake response below has no `clearCookie` to call.
const clearSessionCookie = vi.fn();
vi.mock("../auth/sessionCookie.js", () => ({
  clearSessionCookie: (...a: unknown[]) => clearSessionCookie(...a),
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
  MENSAJE_ULTIMO_FACTOR_ELIMINADO,
  MENSAJE_ULTIMA_CREDENCIAL_QUEDA_CORREO,
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
      return res.body as { message?: string; secreto?: string; otpauth?: string; codigos?: string[] | null };
    },
  };
}

beforeEach(() => {
  // Reset like everything else here. Left alone, a call from the last-factor
  // test above leaked into its neighbours and satisfied their assertion before
  // they ran — the inverted mutation (`if (quedaAlgunFactor)`) stayed green.
  clearSessionCookie.mockReset();
  usuarioFindByPk.mockReset().mockResolvedValue(usuarioRow());
  factorFindOne.mockReset().mockResolvedValue(null);
  factorUpdate.mockReset().mockResolvedValue([1]);
  factorDestroy.mockReset().mockResolvedValue(1);
  guardarSecretoSinConfirmar.mockReset().mockResolvedValue({ id: 55 });
  leerSecretoSinConfirmar.mockReset().mockResolvedValue(null);
  confirmarFactor.mockReset().mockResolvedValue(undefined);
  promoverSesion.mockReset().mockResolvedValue(true);
  sellarPruebaDeFactor.mockReset().mockResolvedValue(undefined);
  apagarLaMecha.mockReset().mockResolvedValue(undefined);
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  tieneCredencialRegistrada.mockReset().mockResolvedValue(false);
  revokeAllRememberedDevicesOf.mockReset().mockResolvedValue(0);
  revokeAllSessionsOf.mockReset().mockResolvedValue(0);
  // Default: nothing outstanding yet, so `confirmTotp` takes the "issue the
  // first ten" branch unless a test says otherwise — the common case for
  // every pre-existing test in this file, none of which registered a factor
  // before confirming this one.
  contarCodigosRestantes.mockReset().mockResolvedValue(0);
  // `prepararCodigos` hashea (caro) y devuelve las filas ya listas;
  // `escribirCodigos` sólo escribe. Partidas para que los 2,6 segundos de
  // bcrypt no transcurran dentro de la transacción.
  prepararCodigos.mockReset().mockImplementation(async () => ({
    codigos: Array.from({ length: 10 }, (_, i) => `CODIGO-${i}`),
    filas: [],
    ahora: new Date(),
  }));
  escribirCodigos.mockReset().mockResolvedValue(undefined);
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

  describe("hallazgo F2/B-1 — a session that opened `completa` already", () => {
    // `estadoInicialDeSesion` opens a session `completa` for an account with
    // no factor still inside its grace period. `promoverSesion`'s WHERE
    // only matches `parcial`/`onboarding`, so on this session it returns
    // `false` and writes nothing — that is not a broken mock, it is exactly
    // what the real function does for a row that is already `completa`.
    function fijarCodigoValido() {
      const { secret, base32 } = secretoDeFila();
      leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });
      return TOTP.generate({ secret, algorithm: "SHA1", digits: 6, period: 30, timestamp: FIXED_NOW });
    }

    it("seals mfa_satisfied_at/mfa_source on its own session when promoverSesion found nothing to promote", async () => {
      promoverSesion.mockResolvedValue(false);
      const codigo = fijarCodigoValido();
      const c = call(CALLER, { codigo });

      await confirmTotp(c.req, c.res);

      // 🔴 The load-bearing assertion. Before this fix, `confirmTotp` called
      // `promoverSesion` and never looked at its return — so this exact
      // scenario (registering on time) left `mfa_satisfied_at` unsealed
      // forever, and every later `requireStepUp` call refused the session.
      expect(c.status).toBe(200);
      expect(sellarPruebaDeFactor).toHaveBeenCalledWith(CALLER.id_sesion, "totp", {
        transaction: TRANSACCION,
      });
    });

    it("does not double-write when promoverSesion did promote a parcial/onboarding row", async () => {
      promoverSesion.mockResolvedValue(true);
      const codigo = fijarCodigoValido();
      const c = call(CALLER, { codigo });

      await confirmTotp(c.req, c.res);

      expect(c.status).toBe(200);
      expect(sellarPruebaDeFactor).not.toHaveBeenCalled();
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

  describe("issuing the first ten recovery codes on confirm (Isaias, 2026-09-02)", () => {
    // Before this decision, confirming a factor never generated a recovery
    // net — somebody had to remember to go find a *different* screen and
    // type their password again. Whoever scanned the QR and closed the tab
    // had exactly one working factor and zero ways back in if it broke.
    function fijarCodigoValido() {
      const { secret, base32 } = secretoDeFila();
      leerSecretoSinConfirmar.mockResolvedValue({ id: 55, secreto: base32 });
      return TOTP.generate({ secret, algorithm: "SHA1", digits: 6, period: 30, timestamp: FIXED_NOW });
    }

    it("generates and returns ten codes when the account has none outstanding", async () => {
      contarCodigosRestantes.mockResolvedValue(0);
      const codigosGenerados = Array.from({ length: 10 }, (_, i) => `CODIGO-${i}`);
      prepararCodigos.mockResolvedValue({ codigos: codigosGenerados, filas: [], ahora: new Date() });
      const c = call(CALLER, { codigo: fijarCodigoValido() });

      await confirmTotp(c.req, c.res);

      expect(c.status).toBe(200);
      // Both reads/writes carry the transaction this handler already opened
      // for `confirmarFactor`/`promoverSesion`/`apagarLaMecha` — see the
      // atomicity test below for why that is not optional.
      expect(contarCodigosRestantes).toHaveBeenCalledWith(CALLER.id, { transaction: TRANSACCION });
      // 🔴 El hashing, FUERA de la transacción; la escritura, dentro. Los diez
      // bcrypt cuestan 2646 ms medidos, y hacerlos dentro retenía los bloqueos
      // de fila y una conexión del pool todo ese rato.
      expect(prepararCodigos).toHaveBeenCalledWith(CALLER.id);
      expect(escribirCodigos).toHaveBeenCalledWith(
        CALLER.id,
        expect.anything(),
        TRANSACCION,
      );
      expect(c.payload.codigos).toEqual(codigosGenerados);
    });

    it("does not regenerate, and answers with no codes, when an outstanding sheet already exists", async () => {
      // The scenario the "only the first factor" rule protects: this TOTP
      // factor was deleted and a new one is being registered (`deleteTotp`
      // never touches `codigo_recuperacion`), or a second factor is being
      // added, while the ten codes printed earlier are still good.
      // Regenerating here would silently turn that sheet into ten dead
      // strings — worse than the bug this whole feature exists to fix.
      contarCodigosRestantes.mockResolvedValue(4);
      const c = call(CALLER, { codigo: fijarCodigoValido() });

      await confirmTotp(c.req, c.res);

      expect(c.status).toBe(200);
      expect(escribirCodigos).not.toHaveBeenCalled();
      expect(c.payload.codigos).toBeNull();
    });

    it("never confirms the factor when generating the recovery codes fails — atomicity", async () => {
      contarCodigosRestantes.mockResolvedValue(0);
      escribirCodigos.mockRejectedValue(new Error("boom"));
      const c = call(CALLER, { codigo: fijarCodigoValido() });

      await confirmTotp(c.req, c.res);

      // `makeHandler` (`utils/handler.ts`) turns the rejection into a 500
      // instead of letting the request hang — that much is generic. The
      // load-bearing part is what never ran *after* the failure: no success
      // response and no `TOTP_CONFIRMED` bitácora line, because the read that
      // decided to generate, the generation itself, and every write that
      // finishes confirming the factor all share this handler's one
      // transaction — a real rejection here rolls every one of them back
      // together, so the factor never actually confirms.
      expect(c.status).toBe(500);
      expect(c.payload.message).not.toBe(MENSAJE_FACTOR_CONFIRMADO);
      expect(logAction).not.toHaveBeenCalled();
    });
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

  it("tells somebody who removed their last factor that they are about to be logged out", async () => {
    // The response used to say only "Factor de autenticación eliminado." while
    // `revokeAllSessionsOf` — deliberately without `except` — was ending the very
    // tab that had just pressed the button. So the person read a cheerful
    // confirmation and the application then threw them out with "your session
    // ended", which reads as something having gone wrong.
    //
    // Three things, in this order, because it is what they need: what happened,
    // what it means from now on, and what to do next.
    factorFindOne.mockResolvedValue({ dataValues: { id: 10, confirmed_at: new Date() } });
    tieneAlgunFactor.mockResolvedValue(false);
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload.message).toBe(MENSAJE_ULTIMO_FACTOR_ELIMINADO);
    expect(c.payload.message).not.toBe(MENSAJE_FACTOR_ELIMINADO);
  });

  it("keeps the plain message when another factor survives, since nothing was revoked", async () => {
    // The other side of the same rule: with a factor left, no sessions are
    // revoked and nobody is about to be thrown out, so promising it would be a
    // second, opposite kind of lie.
    factorFindOne.mockResolvedValue({ dataValues: { id: 10, confirmed_at: new Date() } });
    tieneCredencialRegistrada.mockResolvedValue(true);
    tieneAlgunFactor.mockResolvedValue(true);
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.payload.message).toBe(MENSAJE_FACTOR_ELIMINADO);
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
    tieneCredencialRegistrada.mockResolvedValue(true);
    tieneAlgunFactor.mockResolvedValue(true);
    const c = call(CALLER);

    await deleteTotp(c.req, c.res);

    expect(c.status).toBe(200);
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
    // The negative half of the cookie rule: with another factor left, the
    // caller's session survives and so must the cookie.
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        action: "TOTP_DELETED",
        metadata: expect.objectContaining({ ultimo_factor: false }),
      }),
    );
  });

  describe("hallazgo F7/C-5/B-3 — revoking live sessions when the last factor goes", () => {
    it("revokes every live session of the account when this was the last factor", async () => {
      factorFindOne.mockResolvedValue({ dataValues: { id: 13, confirmed_at: new Date() } });
      tieneAlgunFactor.mockResolvedValue(false);
      revokeAllSessionsOf.mockResolvedValue(3);
      const c = call(CALLER);

      await deleteTotp(c.req, c.res);

      // 🔴 The load-bearing assertion: `factorInventory.ts` declares this a
      // non-optional duty of this endpoint. Without it, every session that
      // was `completa` before this call stays `completa` — `estadoEfectivo`
      // never re-checks whether the account still holds a factor — and once
      // `tieneAlgunFactor` answers `false`, `requireStepUp`'s "nothing to
      // prove" branch waves those stale sessions through the security panel
      // on the cookie alone.
      expect(c.status).toBe(200);
      expect(revokeAllSessionsOf).toHaveBeenCalledWith(CALLER.id);
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TOTP_DELETED",
          metadata: expect.objectContaining({ ultimo_factor: true, sesiones_revocadas: 3 }),
        }),
      );
      // The caller's own session was among the revoked and the message says
      // so; without this the browser keeps a dead cookie and the next request
      // is a bare 401. Found auditing the passkey twin of this route.
      expect(clearSessionCookie).toHaveBeenCalled();
    });

    it("spares no session — no `except` for the caller's own, unlike changePassword's self-change rotation", async () => {
      factorFindOne.mockResolvedValue({ dataValues: { id: 14, confirmed_at: new Date() } });
      tieneAlgunFactor.mockResolvedValue(false);
      const c = call(CALLER);

      await deleteTotp(c.req, c.res);

      // A single positional argument: no `{ except: ... }` sparing the
      // session that is making this very request. See the docstring on
      // `deleteTotp` for why revoking everything, including this tab, is
      // the decision — degrading in place has nothing left for `/mfa/verify`
      // to lift a session back out of, on an account with zero factors.
      expect(revokeAllSessionsOf).toHaveBeenCalledWith(CALLER.id);
      expect(revokeAllSessionsOf.mock.calls[0]).toHaveLength(1);
    });

    it("does not revoke any session when another factor remains on the account", async () => {
      factorFindOne.mockResolvedValue({ dataValues: { id: 15, confirmed_at: new Date() } });
      tieneCredencialRegistrada.mockResolvedValue(true);
      tieneAlgunFactor.mockResolvedValue(true);
      const c = call(CALLER);

      await deleteTotp(c.req, c.res);

      expect(c.status).toBe(200);
      expect(revokeAllSessionsOf).not.toHaveBeenCalled();
    });

    it("does not revoke any session when the deleted row was never confirmed", async () => {
      factorFindOne.mockResolvedValue({ dataValues: { id: 16, confirmed_at: null } });
      const c = call(CALLER);

      await deleteTotp(c.req, c.res);

      expect(c.status).toBe(200);
      expect(tieneAlgunFactor).not.toHaveBeenCalled();
      expect(revokeAllSessionsOf).not.toHaveBeenCalled();
    });
  });
});

// Plan 4E: the third tail. The last credential goes, the verified address
// stays — so the account still has a factor. Sessions survive; the remembered
// devices do not, because they were trusted on the strength of the app.
describe("deleteTotp — the last credential goes but the verified email stays (plan 4E)", () => {
  const ultimaAppConCorreo = () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 20, confirmed_at: new Date() } });
    tieneCredencialRegistrada.mockResolvedValue(false);
    tieneAlgunFactor.mockResolvedValue(true);
  };

  it("says the next login will ask for a code by email, and keeps the session", async () => {
    ultimaAppConCorreo();
    const c = call(CALLER);
    await deleteTotp(c.req, c.res);
    expect(c.status).toBe(200);
    expect(c.payload.message).toBe(MENSAJE_ULTIMA_CREDENCIAL_QUEDA_CORREO);
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });

  it("revokes the remembered devices all the same: they were trusted on the strength of the app", async () => {
    ultimaAppConCorreo();
    const c = call(CALLER);
    await deleteTotp(c.req, c.res);
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(CALLER.id);
  });

  it("files a warning that names what remains, not a critical last-factor line", async () => {
    ultimaAppConCorreo();
    const c = call(CALLER);
    await deleteTotp(c.req, c.res);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TOTP_DELETED",
        severity: "warning",
        metadata: expect.objectContaining({ ultimo_factor: false, ultima_credencial: true, queda_correo: true }),
      }),
    );
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
  });

  it("asks the factor question only when no credential is left", async () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 21, confirmed_at: new Date() } });
    tieneCredencialRegistrada.mockResolvedValue(true);
    const c = call(CALLER);
    await deleteTotp(c.req, c.res);
    expect(tieneAlgunFactor).not.toHaveBeenCalled();
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
  });

  it("still revokes everything when neither a credential nor a verified address remains", async () => {
    factorFindOne.mockResolvedValue({ dataValues: { id: 22, confirmed_at: new Date() } });
    tieneCredencialRegistrada.mockResolvedValue(false);
    tieneAlgunFactor.mockResolvedValue(false);
    const c = call(CALLER);
    await deleteTotp(c.req, c.res);
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(CALLER.id);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(CALLER.id);
    expect(clearSessionCookie).toHaveBeenCalled();
    expect(c.payload.message).toBe(MENSAJE_ULTIMO_FACTOR_ELIMINADO);
  });
});
