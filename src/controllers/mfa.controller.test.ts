// `POST /auth/mfa/verify` and `POST /auth/stepup` — Tasks 7 and 17 of
// `docs/plans/2026-09-01-factores-mfa.md`. Hallazgos C3, C10, C12, C13, C14,
// C15, B12.
//
// **Real crypto, fake table** — the same split `mfaKeyCheck.test.ts` and
// `totpStore.test.ts` already use, and for the same reason: a canned
// `descifrar` result cannot show whether this file actually authenticates
// anything, and hallazgo B12's whole point is that a wrong code, a corrupt
// row and a wrong key must be indistinguishable *through the real crypto
// path*, not through three branches of a mock that happen to return the same
// string. `FactorTotpModel`, `UsuarioModel`, `SesionModel`, `recoveryCodeStore.js`
// and `logAction` are the only things mocked; `mfaCrypto.ts`, `mfaKeyring.ts`,
// `totpStore.ts`'s pure helpers (`aadDeFactorTotp`, `sellarPaso`,
// `pasoYaUsado`), `sessionPromotion.ts` and `otpauth` itself all run for
// real.
//
// **Nothing here writes to a real database.** `logAction` goes through
// `BitacoraModel.create`, which is why it is mocked rather than left real —
// the common brief for this arc is explicit that no 4B test may touch
// `osefi_local`, a copy of production with nine real people's rows in it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import * as OTPAuth from "otpauth";
import { cifrar } from "../auth/mfaCrypto.js";
import { aadDeFactorTotp } from "../auth/totpStore.js";
import { LOCKOUT_AFTER_FAILURES } from "../config/security.js";

interface FilaFake {
  id: number;
  id_usuario: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  ultimo_paso: string | null;
  confirmed_at: Date | null;
}

let filas: FilaFake[] = [];

const factorUpdate = vi.fn();
vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: {
    unscoped: () => ({
      findOne: (opciones: { where: { id_usuario: number; confirmed_at?: unknown } }) => {
        const fila = filas.find(
          (f) => f.id_usuario === opciones.where.id_usuario && f.confirmed_at !== null,
        );
        return Promise.resolve(fila ? { get: () => ({ ...fila }) } : null);
      },
    }),
    update: (...a: unknown[]) => factorUpdate(...(a as [Record<string, unknown>, { where: { id: number } }])),
  },
}));
// `sellarPaso` (real, from `totpStore.ts`) writes through this mock — see
// `resetFilas`'s implementation below, which is what makes a second call to
// `verificarTotp` in the same test see the sealed step, exactly the way a
// real `UPDATE` followed by a real `SELECT` would.
factorUpdate.mockImplementation(
  (valores: Record<string, unknown>, opciones: { where: { id: number } }) => {
    let contador = 0;
    filas = filas.map((f) => {
      if (f.id !== opciones.where.id) return f;
      contador += 1;
      // `pg` hands `BIGINT` back as a string — `String(...)` here is what
      // keeps a second read of this row shaped the way hallazgo C10 demands,
      // rather than the `number` `sellarPaso` happens to write with.
      return { ...f, ultimo_paso: String(valores.ultimo_paso) };
    });
    return Promise.resolve([contador]);
  },
);

const findByPk = vi.fn();
const findOneUsuario = vi.fn();
const increment = vi.fn().mockResolvedValue(undefined);
const updateUsuario = vi.fn().mockResolvedValue(undefined);
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findByPk: (...a: unknown[]) => findByPk(...a),
    findOne: (...a: unknown[]) => findOneUsuario(...a),
    increment: (...a: unknown[]) => increment(...a),
    update: (...a: unknown[]) => updateUsuario(...a),
  },
}));

const sesionUpdate = vi.fn();
vi.mock("../models/sesion.model.js", () => ({
  SesionModel: { update: (...a: unknown[]) => sesionUpdate(...a) },
}));

const gastarCodigo = vi.fn();
vi.mock("../auth/recoveryCodeStore.js", () => ({
  gastarCodigo: (...a: unknown[]) => gastarCodigo(...a),
}));

const logActionMock = vi.fn();
// `verify` now mints the remembered-device cookie — the one place that can,
// since the login only ever *renews* one that is already valid. Mocked at the
// module because `rememberedDeviceIssue.js` reaches `dispositivoRecordado.model.ts`,
// which defines a real model against the fake `sequelize` below and fails the
// whole file at load with "sequelize.define is not a function".
const acunarDispositivo = vi.fn(async () => "token-de-dispositivo");
const setRememberedDeviceCookie = vi.fn();
vi.mock("../auth/rememberedDeviceIssue.js", () => ({
  acunarDispositivo: (...a: unknown[]) => acunarDispositivo(...(a as [])),
  setRememberedDeviceCookie: (...a: unknown[]) => setRememberedDeviceCookie(...(a as [])),
}));
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logActionMock(...a) }));

vi.mock("../permissions/store.js", () => ({ permissionsFor: vi.fn().mockResolvedValue({ x: true }) }));

const transaction = vi.fn((fn: (t: unknown) => Promise<unknown>) => fn({ id: "tx" }));
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...a: unknown[]) => transaction(...(a as [(t: unknown) => Promise<unknown>])) },
}));

// `sessionPromotion.ts` is real (imported transitively through
// `mfa.controller.ts`, never mocked here): it is what Task 5 built and
// verified, and `verify`'s whole reason for existing is to compose correctly
// with it — a mock here would hide exactly the wiring hallazgo D2 and
// Decision 8 are about (a promoted session actually leaving
// `parcial`/`onboarding`).
const {
  verify,
  stepup,
  CODIGO_MFA_INVALIDO,
  CODIGO_REQUERIDO,
} = await import("./mfa.controller.js");

const CLAVE_1 = "1".repeat(64);
const ID_USUARIO = 42;
const OTRO_USUARIO = 99;
const ID_SESION = "11111111-1111-1111-1111-111111111111";
const SECRETO = "JBSWY3DPEHPK3PXP";
// Mirrors `VENTANA_DIAGNOSTICO` in `mfa.controller.ts` — kept private there
// (see that file), so tests that need to stay inside or outside it name the
// number here instead of importing it.
const VENTANA_DIAGNOSTICO = 10;

function usarLlaveUnica(): void {
  vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_1);
  vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
}

function filaTotp(
  id: number,
  id_usuario: number,
  secreto = SECRETO,
  ultimo_paso: string | null = null,
): FilaFake {
  const cifrado = cifrar(secreto, aadDeFactorTotp(id));
  return {
    id,
    id_usuario,
    secreto_cifrado: cifrado.ciphertext,
    iv: cifrado.iv,
    auth_tag: cifrado.auth_tag,
    key_version: cifrado.key_version,
    ultimo_paso,
    confirmed_at: new Date("2026-08-20T09:00:00.000Z"),
  };
}

/** A six-digit string that does not validate against `secret` anywhere in
 *  `±VENTANA_DIAGNOSTICO` steps of `counter` — real "wrong code", not a
 *  1-in-a-million coincidence left to chance. */
function codigoQueNuncaValida(secret: OTPAuth.Secret, counter: number): string {
  const validos = new Set<string>();
  for (let d = -VENTANA_DIAGNOSTICO; d <= VENTANA_DIAGNOSTICO; d++) {
    validos.add(OTPAuth.HOTP.generate({ secret, counter: counter + d }));
  }
  for (let n = 0; n <= 999_999; n++) {
    const candidato = String(n).padStart(6, "0");
    if (!validos.has(candidato)) return candidato;
  }
  throw new Error("no six-digit code was left outside the window — cannot happen");
}

function usuarioAutenticado(overrides: Record<string, unknown> = {}) {
  return {
    id: ID_USUARIO,
    id_rol: 3,
    id_sesion: ID_SESION,
    expires_at: new Date("2026-09-08T00:00:00.000Z"),
    estado: "parcial",
    mfa_satisfied_at: null,
    ...overrides,
  };
}

function call(body: unknown, user: Record<string, unknown> | null = usuarioAutenticado()) {
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
    req: { body, ip: "203.0.113.9", originalUrl: "/api/auth/mfa/verify", user } as unknown as Request,
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

beforeEach(() => {
  vi.clearAllMocks();
  filas = [];
  usarLlaveUnica();
  findByPk.mockResolvedValue({ dataValues: { failed_attempts: 0, locked_until: null } });
  findOneUsuario.mockResolvedValue({ dataValues: { failed_attempts: 1 } });
  gastarCodigo.mockResolvedValue(false);
  sesionUpdate.mockResolvedValue([1]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /auth/mfa/verify", () => {
  it("requires the code field, and charges nothing for an empty submission", async () => {
    const c = call({});
    await verify(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_REQUERIDO);
    expect(increment).not.toHaveBeenCalled();
  });

  it("increments failed_attempts on a wrong code", async () => {
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    filas = [filaTotp(1, ID_USUARIO)];

    const c = call({ codigo: codigoQueNuncaValida(secret, counter) });
    await verify(c.req, c.res);

    expect(c.status).toBe(400);
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
  });

  it("locks the account after the same number of failures a wrong password would", async () => {
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    filas = [filaTotp(1, ID_USUARIO)];
    findByPk.mockResolvedValue({
      dataValues: { failed_attempts: LOCKOUT_AFTER_FAILURES - 1, locked_until: null },
    });
    findOneUsuario.mockResolvedValue({ dataValues: { failed_attempts: LOCKOUT_AFTER_FAILURES } });

    const c = call({ codigo: codigoQueNuncaValida(secret, counter) });
    await verify(c.req, c.res);

    expect(updateUsuario).toHaveBeenCalledTimes(1);
    const [valores] = updateUsuario.mock.calls[0] as [{ locked_until: Date }];
    expect(valores.locked_until).toBeInstanceOf(Date);
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ACCOUNT_LOCKED", id_usuario: ID_USUARIO }),
    );
  });

  it("refuses without even comparing anything once the account is resting", async () => {
    findByPk.mockResolvedValue({
      dataValues: { failed_attempts: 999, locked_until: new Date(Date.now() + 60_000) },
    });
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const valido = OTPAuth.HOTP.generate({ secret, counter });

    const c = call({ codigo: valido });
    await verify(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    // Not even the genuinely correct code is looked at while resting.
    expect(increment).not.toHaveBeenCalled();
    expect(factorUpdate).not.toHaveBeenCalled();
  });

  it("looks the factor up by the session's user, never by anything in the body", async () => {
    // Two accounts, two different confirmed secrets. Authenticated as the
    // victim (ID_USUARIO); the body carries the attacker's valid code *and*
    // a spoofed id_usuario pointing at the attacker's own account —
    // hallazgo C15's exact shape.
    const secretoAtacante = "MFRGGZDFMZTWQ2LK";
    filas = [filaTotp(1, ID_USUARIO, SECRETO), filaTotp(2, OTRO_USUARIO, secretoAtacante)];
    const secretAtacante = OTPAuth.Secret.fromBase32(secretoAtacante);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const codigoAtacante = OTPAuth.HOTP.generate({ secret: secretAtacante, counter });

    const c = call(
      { codigo: codigoAtacante, id_usuario: OTRO_USUARIO },
      usuarioAutenticado({ id: ID_USUARIO }),
    );
    await verify(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    expect(sesionUpdate).not.toHaveBeenCalled();
  });

  it("accepts a genuinely valid code and promotes the session", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const valido = OTPAuth.HOTP.generate({ secret, counter });

    const c = call({ codigo: valido });
    await verify(c.req, c.res);

    expect(c.status).toBe(200);
    expect(sesionUpdate).toHaveBeenCalledTimes(1);
    const [valores, opciones] = sesionUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(valores).toMatchObject({ estado: "completa", mfa_source: "totp" });
    // `promoverSesion` (real) puts the id under `where.id` — the caller's
    // own `id_sesion`, never anything from the body.
    expect(opciones.where.id).toBe(ID_SESION);
  });

  it("refuses a step it has already accepted", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const valido = OTPAuth.HOTP.generate({ secret, counter });

    const primero = call({ codigo: valido });
    await verify(primero.req, primero.res);
    expect(primero.status).toBe(200);

    // Same code, same request, same account: the store now holds the
    // sealed step (via the real `sellarPaso` writing through `factorUpdate`).
    const segundo = call({ codigo: valido });
    await verify(segundo.req, segundo.res);

    expect(segundo.status).toBe(400);
    expect(segundo.message).toBe(CODIGO_MFA_INVALIDO);
  });

  it("does not accept a code that is only valid ten steps away", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const desfasado = OTPAuth.HOTP.generate({ secret, counter: counter + 5 });

    const c = call({ codigo: desfasado });
    await verify(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    // Diagnosed, but never sealed and never promoted — the diagnostic path
    // must not accept (hallazgo C12 rule 1).
    expect(factorUpdate).not.toHaveBeenCalled();
    expect(sesionUpdate).not.toHaveBeenCalled();
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
  });

  it("logs a clock-skew diagnosis without ever putting it in the response", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const desfasado = OTPAuth.HOTP.generate({ secret, counter: counter + 3 });

    const c = call({ codigo: desfasado });
    await verify(c.req, c.res);

    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MFA_CLOCK_SKEW_DETECTED", metadata: { delta_pasos: 3 } }),
    );
  });

  it("answers the same for a wrong code, a corrupt row and a wrong key", async () => {
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

    // 1. A plain wrong code, against a perfectly healthy row.
    filas = [filaTotp(1, ID_USUARIO)];
    const codigoMalo = call({ codigo: codigoQueNuncaValida(secret, counter) });
    await verify(codigoMalo.req, codigoMalo.res);

    // 2. A corrupt row: the tag no longer authenticates.
    vi.clearAllMocks();
    findByPk.mockResolvedValue({ dataValues: { failed_attempts: 0, locked_until: null } });
    findOneUsuario.mockResolvedValue({ dataValues: { failed_attempts: 1 } });
    const filaSana = filaTotp(2, ID_USUARIO);
    const tagRoto = Buffer.from(filaSana.auth_tag);
    tagRoto[0] ^= 0xff;
    filas = [{ ...filaSana, auth_tag: tagRoto }];
    const filaCorrupta = call({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
    await verify(filaCorrupta.req, filaCorrupta.res);

    // 3. The right ciphertext, under a key this process no longer holds.
    vi.clearAllMocks();
    findByPk.mockResolvedValue({ dataValues: { failed_attempts: 0, locked_until: null } });
    findOneUsuario.mockResolvedValue({ dataValues: { failed_attempts: 1 } });
    filas = [{ ...filaTotp(3, ID_USUARIO), key_version: 2 }];
    const claveEquivocada = call({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
    await verify(claveEquivocada.req, claveEquivocada.res);

    expect(codigoMalo.status).toBe(400);
    expect(filaCorrupta.status).toBe(codigoMalo.status);
    expect(claveEquivocada.status).toBe(codigoMalo.status);
    expect(filaCorrupta.payload).toEqual(codigoMalo.payload);
    expect(claveEquivocada.payload).toEqual(codigoMalo.payload);
  });

  it("accepts a valid recovery code, spends it and promotes the session in one transaction", async () => {
    gastarCodigo.mockResolvedValue(true);

    const c = call({ codigo: "A".repeat(26) });
    await verify(c.req, c.res);

    expect(c.status).toBe(200);
    expect(gastarCodigo).toHaveBeenCalledWith(ID_USUARIO, "A".repeat(26), { transaction: { id: "tx" } });
    expect(sesionUpdate).toHaveBeenCalledTimes(1);
    const [valores] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(valores.mfa_source).toBe("codigo");
  });

  it("rolls back the spent code when there is nothing left to promote", async () => {
    gastarCodigo.mockResolvedValue(true);
    sesionUpdate.mockResolvedValue([0]); // nothing matched — already `completa`

    const c = call({ codigo: "A".repeat(26) }, usuarioAutenticado({ estado: "completa" }));
    await verify(c.req, c.res);

    // The transaction's own callback threw, so `sequelize.transaction`
    // (mocked as a bare passthrough) rejects; the code was "spent" against
    // the fake, but the caller is told the whole attempt failed rather than
    // being handed a silent, wasted success.
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
  });

  it("clears a stale lockout on success", async () => {
    findByPk.mockResolvedValue({ dataValues: { failed_attempts: 3, locked_until: null } });
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

    const c = call({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
    await verify(c.req, c.res);

    expect(updateUsuario).toHaveBeenCalledWith(
      { failed_attempts: 0, locked_until: null },
      { where: { id: ID_USUARIO } },
    );
  });

  describe("«recordar este equipo», which only this endpoint can grant", () => {
    /**
     * The login **renews** a device cookie that is already valid and never
     * mints a first one — deliberately, since at that point nobody has proved
     * anything beyond a password. So this is the only place the first cookie
     * can come from, and until it existed the whole feature was
     * chicken-and-egg: renewal needs a cookie, and nothing handed out the
     * first. A comment in `auth.controller.ts` already described minting as if
     * it happened here.
     */
    const codigoValido = () => {
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
      return OTPAuth.HOTP.generate({ secret, counter });
    };

    it("mints the cookie when the body asks and the factor was proved", async () => {
      filas = [filaTotp(1, ID_USUARIO)];
      const c = call({ codigo: codigoValido(), recordar: true });
      await verify(c.req, c.res);

      expect(c.status).toBe(200);
      expect(acunarDispositivo).toHaveBeenCalledWith(ID_USUARIO, expect.anything());
      expect(setRememberedDeviceCookie).toHaveBeenCalled();
    });

    it("mints nothing when the body does not ask", async () => {
      // Never automatic, the same rule the login's renewal follows: a cookie
      // that skips the second factor is opt-in or it is not a choice.
      filas = [filaTotp(1, ID_USUARIO)];
      const c = call({ codigo: codigoValido() });
      await verify(c.req, c.res);

      expect(c.status).toBe(200);
      expect(acunarDispositivo).not.toHaveBeenCalled();
    });

    it("mints nothing when the code was wrong, however loudly the body asks", async () => {
      // The half that matters. Minting on a failed verification would hand the
      // cookie that skips the second factor to somebody who just failed to
      // produce one — which is the entire attack this feature could become.
      filas = [filaTotp(1, ID_USUARIO)];
      const c = call({ codigo: "000000", recordar: true });
      await verify(c.req, c.res);

      expect(c.status).not.toBe(200);
      expect(acunarDispositivo).not.toHaveBeenCalled();
      expect(setRememberedDeviceCookie).not.toHaveBeenCalled();
    });

    it("still verifies the factor when the cookie cannot be written", async () => {
      // Swallowed, not turned into a 5xx: the session is already promoted and
      // works without the cookie. Refusing here would cost somebody their whole
      // verification over a convenience that saves them typing six digits.
      filas = [filaTotp(1, ID_USUARIO)];
      acunarDispositivo.mockRejectedValueOnce(new Error("la base dijo que no"));

      const c = call({ codigo: codigoValido(), recordar: true });
      await verify(c.req, c.res);

      expect(c.status).toBe(200);
      expect(setRememberedDeviceCookie).not.toHaveBeenCalled();
    });
  });
});

describe("POST /auth/stepup", () => {
  function callStepup(body: unknown, overrides: Record<string, unknown> = {}) {
    return call(body, usuarioAutenticado({ estado: "completa", mfa_satisfied_at: null, ...overrides }));
  }

  it("re-seals a live complete session with a totp code", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

    const c = callStepup({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
    await stepup(c.req, c.res);

    expect(c.status).toBe(200);
    expect(sesionUpdate).toHaveBeenCalledTimes(1);
    const [valores, opciones] = sesionUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(valores.mfa_source).toBe("totp");
    expect(valores.mfa_satisfied_at).toBeInstanceOf(Date);
    // `estado` is never part of the write — only read, in the WHERE.
    expect(valores).not.toHaveProperty("estado");
    expect(opciones.where).toMatchObject({
      id: ID_SESION,
      id_usuario: ID_USUARIO,
      estado: "completa",
    });
  });

  it("re-seals with a recovery code", async () => {
    gastarCodigo.mockResolvedValue(true);

    const c = callStepup({ codigo: "B".repeat(26) });
    await stepup(c.req, c.res);

    expect(c.status).toBe(200);
    expect(gastarCodigo).toHaveBeenCalledWith(ID_USUARIO, "B".repeat(26), { transaction: { id: "tx" } });
    const [valores] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(valores.mfa_source).toBe("codigo");
  });

  it("refuses a remembered device — there is no field this endpoint reads that a cookie could satisfy", async () => {
    // No `codigo` at all: a remembered-device cookie carries no code, and
    // this handler never inspects cookies in the first place.
    const c = callStepup({});
    await stepup(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_REQUERIDO);
    expect(sesionUpdate).not.toHaveBeenCalled();
    expect(gastarCodigo).not.toHaveBeenCalled();
  });

  it("refuses a password on an account that has a factor", async () => {
    const c = callStepup({ stepup_password: "una-contraseña-perfectamente-correcta" });
    await stepup(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_REQUERIDO);
    expect(sesionUpdate).not.toHaveBeenCalled();
  });

  it("charges a failed attempt the same way mfa/verify does", async () => {
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    filas = [filaTotp(1, ID_USUARIO)];

    const c = callStepup({ codigo: codigoQueNuncaValida(secret, counter) });
    await stepup(c.req, c.res);

    expect(c.status).toBe(400);
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
  });

  it("scopes the re-seal to the caller's own session and account", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

    const c = callStepup(
      { codigo: OTPAuth.HOTP.generate({ secret, counter }), id_sesion: "spoofed", id_usuario: OTRO_USUARIO },
    );
    await stepup(c.req, c.res);

    const [, opciones] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    // The spoofed body fields are simply never read — the WHERE names only
    // what `req.user` (authenticate) put there.
    expect(opciones.where.id).toBe(ID_SESION);
    expect(opciones.where.id_usuario).toBe(ID_USUARIO);
  });
});
