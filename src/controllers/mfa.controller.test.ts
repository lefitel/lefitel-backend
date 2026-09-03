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
// `sellarPaso` (real, from `totpStore.ts`) writes through this mock. Its
// `where` now carries the atomic anti-replay guard hallazgo F4/C-3/A-8 added
// — `id` plus `ultimo_paso IS NULL OR ultimo_paso < :paso` — and this fake
// has to actually enforce that second half, not just `id`: otherwise a
// concurrency test racing two `verify()` calls with the same code would pass
// whether or not the real guard exists, which is precisely the kind of test
// this whole audit exists to rule out. Deliberately synchronous — no `await`
// before the mutation — so two overlapping calls interleave the same way two
// real transactions racing the same `UPDATE` would: whichever's write lands
// first is the only one that can still match.
factorUpdate.mockImplementation(
  (valores: Record<string, unknown>, opciones: { where: { id: number; [key: symbol]: unknown } }) => {
    const nuevo = BigInt(valores.ultimo_paso as string);
    let contador = 0;
    filas = filas.map((f) => {
      if (f.id !== opciones.where.id) return f;
      const actual = f.ultimo_paso === null ? null : BigInt(f.ultimo_paso);
      if (actual !== null && actual >= nuevo) return f; // Already sealed at or past this step.
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

// `tieneAlgunFactor` (hallazgo F1/C-2/D-1): mocked at the module, the same
// way `gastarCodigo` above is — `factorInventory.test.ts` already covers its
// own two-table COUNT correctness, so this file only needs to control what
// it answers, not re-derive it from a fake `CredencialWebauthnModel` and
// `FactorTotpModel.count` this file has no other reason to stand up.
// Defaults to `true` in `beforeEach` below: every existing recovery-code test
// in this file predates F1 and assumes an account that already has a factor
// to rescue — the account with none is its own, explicit test.
const tieneAlgunFactorMock = vi.fn();
vi.mock("../auth/factorInventory.js", () => ({
  tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactorMock(...a),
}));

// Real `mfaLog` (pino) is otherwise silent-but-untestable; mocked here only
// so hallazgo F5/A5/C-4 — a crypto failure logged at `error`, never `warn` —
// has something to assert against. Same shape `password.controller.test.ts`
// and `securityNotice.test.ts` already use for the same reason.
const loggerWarn = vi.fn();
const loggerError = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn: loggerWarn, error: loggerError, info: vi.fn(), debug: vi.fn() }),
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

// Plan 4E: the email-code arm. The store is mocked at the module the same way
// `gastarCodigo` is — `emailCodeStore.test.ts` covers the SQL; this file
// covers the composition: charge, compare, spend and seal, in that order.
// bcrypt is a shape check (`hash(<code>)`), so a compare against the real
// `fillerHash()` — a genuine bcrypt string — is simply false, which is what
// the no-code path needs it to be.
const cobrarIntento = vi.fn();
const liquidarCodigo = vi.fn();
vi.mock("../auth/emailCodeStore.js", () => ({
  cobrarIntento: (...a: unknown[]) => cobrarIntento(...a),
  liquidarCodigo: (...a: unknown[]) => liquidarCodigo(...a),
}));
const admitirIntentoDeCorreo = vi.fn();
vi.mock("../auth/emailCodeVerifyBudget.js", () => ({
  admitirIntentoDeCorreo: (...a: unknown[]) => admitirIntentoDeCorreo(...a),
}));
const bcryptCompare = vi.fn(async (texto: string, hash: string) => hash === `hash(${texto})`);
vi.mock("bcryptjs", () => ({
  default: {
    compare: (...a: unknown[]) => bcryptCompare(...(a as [string, string])),
    // `fillerHash()` (real, from `config/security.ts`) hashes a random string
    // once; a bcrypt-shaped answer is all it needs, and all the no-code test
    // asserts on.
    hash: async () => `$2b$12$${"f".repeat(53)}`,
  },
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
  METODO_DESCONOCIDO,
  DEMASIADOS_INTENTOS_CORREO,
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
  tieneAlgunFactorMock.mockResolvedValue(true);
  cobrarIntento.mockResolvedValue({ id: 31, codigo_hash: "hash(123456)", agotado: false });
  liquidarCodigo.mockResolvedValue(true);
  admitirIntentoDeCorreo.mockReturnValue(true);
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

  // 🔴 El encierro que este endpoint tenía y nada cubría. `estadoEfectivo`
  // contesta `onboarding` para una fila **guardada** `completa` cuyo plazo
  // venció y que nunca probó un factor — la forma de cualquier sesión que ya
  // estaba abierta cuando su dueño registró su primer factor desde otro
  // aparato. `promoverSesion` mira el estado *guardado*, no encuentra nada, y
  // no escribe: el endpoint contestaba «Segundo factor verificado» sin sellar
  // absolutamente nada, y la siguiente petición volvía a pedir el factor.
  it("seals the session when there was nothing to promote, instead of answering a lie", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const valido = OTPAuth.HOTP.generate({ secret, counter });
    // La promoción no encaja; el sellado sí.
    sesionUpdate.mockResolvedValueOnce([0]).mockResolvedValueOnce([1]);

    const c = call({ codigo: valido });
    await verify(c.req, c.res);

    expect(c.status).toBe(200);
    expect(sesionUpdate).toHaveBeenCalledTimes(2);
    const [valores, opciones] = sesionUpdate.mock.calls[1] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(valores).toMatchObject({ mfa_source: "totp" });
    // El sellado no toca `estado`: no hay nada que promover, sólo prueba que
    // registrar. Es la diferencia entera entre las dos funciones.
    expect(valores).not.toHaveProperty("estado");
    expect(opciones.where).toEqual({ id: ID_SESION });
  });

  it("does not write the session twice when the promotion did match", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const valido = OTPAuth.HOTP.generate({ secret, counter });

    const c = call({ codigo: valido });
    await verify(c.req, c.res);

    expect(sesionUpdate).toHaveBeenCalledTimes(1);
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
    // 🔴 **Qué sigue garantizando este test y qué dejó de garantizar, con el
    // motivo.**
    //
    // La frase y el estado son idénticos, y la **forma** también: las tres
    // respuestas llevan exactamente las mismas claves. Eso es lo que impide
    // distinguir «tu código está mal» de «el servidor no puede leer tu
    // secreto» por la pinta de la respuesta.
    //
    // Lo que **no** puede ser idéntico es el valor de `intentosRestantes`, y
    // no por descuido: un fallo criptográfico **no carga el contador** a
    // propósito (hallazgo F5/A5/C-4 — cargarlo bloquearía justo a la persona a
    // la que una clave rota ya ha dejado tirada), así que su contador no baja.
    // Igualarlo exigiría mentir sobre el número, y la mentira se desharía sola
    // al segundo intento: en el caso normal la cuenta atrás baja y en el otro
    // no. O sea que esa indistinguibilidad nunca existió más allá de una sola
    // petición; lo que se elige aquí es decir la verdad en vez de fingirla.
    //
    // Y quien puede observar la diferencia ya tiene una sesión válida sobre su
    // propia cuenta: lo que aprende es que el servidor tiene un problema de
    // clave, no nada sobre una credencial.
    const sinContador = (p: Record<string, unknown> | undefined) => {
      const { intentosRestantes: _, ...resto } = (p ?? {}) as Record<string, unknown>;
      return resto;
    };
    expect(sinContador(filaCorrupta.payload)).toEqual(sinContador(codigoMalo.payload));
    expect(sinContador(claveEquivocada.payload)).toEqual(sinContador(codigoMalo.payload));
    // La forma sí es idéntica: mismas claves, siempre.
    expect(Object.keys(filaCorrupta.payload ?? {}).sort()).toEqual(
      Object.keys(codigoMalo.payload ?? {}).sort(),
    );
    expect(Object.keys(claveEquivocada.payload ?? {}).sort()).toEqual(
      Object.keys(codigoMalo.payload ?? {}).sort(),
    );
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

  // La otra mitad del mismo fallo, que rompía hacia el lado contrario: un
  // código de recuperación perfectamente válido se deshacía y se contestaba
  // «código incorrecto», siempre, en el único estado que más lo necesitaba.
  it("seals the session rather than rejecting a valid recovery code", async () => {
    gastarCodigo.mockResolvedValue(true);
    sesionUpdate.mockResolvedValueOnce([0]).mockResolvedValueOnce([1]);

    const c = call({ codigo: "A".repeat(26) }, usuarioAutenticado({ estado: "completa" }));
    await verify(c.req, c.res);

    expect(c.status).toBe(200);
    expect(sesionUpdate).toHaveBeenCalledTimes(2);
    const [valores] = sesionUpdate.mock.calls[1] as [Record<string, unknown>];
    expect(valores.mfa_source).toBe("codigo");
  });

  it("rolls back the spent code when there is no session at all to seal", async () => {
    gastarCodigo.mockResolvedValue(true);
    // Las dos escrituras fallan: ni promoción ni sellado. Eso ya no significa
    // «la sesión estaba completa» —ese caso ahora se sella— sino que la fila
    // no está, y gastar uno de diez códigos impresos por nada es lo que este
    // rollback existe para impedir.
    sesionUpdate.mockResolvedValue([0]);

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

  it("lets exactly one of two concurrent requests with the same code through — hallazgo F4/C-3/A-8", async () => {
    // Launched together, not one `await` after another: run in series this
    // passes even against the old read-then-write `sellarPaso`, since a
    // second, later request would simply see the already-sealed step through
    // a fresh read. Only racing them the way `recoveryCodeStore.test.ts`
    // races ten `gastarCodigo` calls at once catches the regression this
    // guards — see `factorUpdate`'s own mock above for the half of this that
    // makes the fake capable of failing at all.
    filas = [filaTotp(1, ID_USUARIO)];
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const valido = OTPAuth.HOTP.generate({ secret, counter });

    const a = call({ codigo: valido });
    const b = call({ codigo: valido });
    await Promise.all([verify(a.req, a.res), verify(b.req, b.res)]);

    const estados = [a.status, b.status].sort((x, y) => x - y);
    expect(estados).toEqual([200, 400]);
    // Exactly one seal survives, whichever request won the race.
    expect(filas[0].ultimo_paso).not.toBeNull();
  });

  describe("a crypto failure never charges the lockout — hallazgo F5/A5/C-4", () => {
    function filaConAuthTagRoto(): FilaFake {
      const fila = filaTotp(1, ID_USUARIO);
      const tagRoto = Buffer.from(fila.auth_tag);
      tagRoto[0] ^= 0xff;
      return { ...fila, auth_tag: tagRoto };
    }

    it("does not increment failed_attempts when the row cannot be decrypted", async () => {
      filas = [filaConAuthTagRoto()];
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

      const c = call({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
      await verify(c.req, c.res);

      expect(c.status).toBe(400);
      expect(c.message).toBe(CODIGO_MFA_INVALIDO);
      expect(increment).not.toHaveBeenCalled();
    });

    it("still charges failed_attempts for a plain wrong code against a healthy row — the exemption above is not a general softening", async () => {
      filas = [filaTotp(1, ID_USUARIO)];
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

      const c = call({ codigo: codigoQueNuncaValida(secret, counter) });
      await verify(c.req, c.res);

      expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
    });

    it("logs the failure at error severity, not warn, so an operator actually sees it", async () => {
      filas = [filaConAuthTagRoto()];
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

      const c = call({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
      await verify(c.req, c.res);

      expect(loggerError).toHaveBeenCalled();
      expect(loggerWarn).not.toHaveBeenCalled();
    });
  });

  describe("estado: \"onboarding\" — hallazgo F1/C-2/D-1, D-1's own missing coverage", () => {
    it("refuses a recovery code when the account has no factor to rescue at all — the exact hole F1 closes", async () => {
      // Day 15: grace expired, zero factors, `onboarding`. `gastarCodigo`
      // resolving `true` stands in for a genuinely unspent, correctly-shaped
      // code — the point is that it must never even be asked, because an
      // account with nothing confirmed has nothing a recovery code could be
      // rescuing. Before this guard existed, inserting it and measuring the
      // suite is exactly what the auditor did to get "23/23 verdes".
      tieneAlgunFactorMock.mockResolvedValue(false);
      gastarCodigo.mockResolvedValue(true);

      const c = call({ codigo: "A".repeat(26) }, usuarioAutenticado({ estado: "onboarding" }));
      await verify(c.req, c.res);

      expect(c.status).toBe(400);
      expect(c.message).toBe(CODIGO_MFA_INVALIDO);
      expect(gastarCodigo).not.toHaveBeenCalled();
      expect(sesionUpdate).not.toHaveBeenCalled();
    });

    it("accepts a recovery code from onboarding when the account already has a confirmed factor to rescue", async () => {
      // The legitimate shape of this same request: somebody who registered a
      // factor, then lost it (a broken phone, a deleted TOTP) while codes
      // printed earlier are still outstanding. `tieneAlgunFactor` answering
      // `true` here is what tells the two apart — never `estado` itself,
      // which this file's guard does not read.
      tieneAlgunFactorMock.mockResolvedValue(true);
      gastarCodigo.mockResolvedValue(true);

      const c = call({ codigo: "A".repeat(26) }, usuarioAutenticado({ estado: "onboarding" }));
      await verify(c.req, c.res);

      expect(c.status).toBe(200);
      expect(sesionUpdate).toHaveBeenCalledTimes(1);
    });

    it("accepts a genuinely valid TOTP code and promotes an onboarding session to completa", async () => {
      filas = [filaTotp(1, ID_USUARIO)];
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

      const c = call(
        { codigo: OTPAuth.HOTP.generate({ secret, counter }) },
        usuarioAutenticado({ estado: "onboarding" }),
      );
      await verify(c.req, c.res);

      expect(c.status).toBe(200);
      expect(sesionUpdate).toHaveBeenCalledTimes(1);
      const [valores] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
      expect(valores).toMatchObject({ estado: "completa", mfa_source: "totp" });
    });

    it("charges a failed attempt for a wrong code from onboarding, exactly like any other session", async () => {
      filas = [filaTotp(1, ID_USUARIO)];
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

      const c = call(
        { codigo: codigoQueNuncaValida(secret, counter) },
        usuarioAutenticado({ estado: "onboarding" }),
      );
      await verify(c.req, c.res);

      expect(c.status).toBe(400);
      expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
    });
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

  // Plan 4E (S11): the guard `verify` has carried since F1, now here too. An
  // email-only account can mint codes, change its address, lose its factor and
  // still be `completa` under a fresh grace clock; a code must not re-seal it.
  it("refuses a recovery code when the account has no factor to rescue, spending nothing", async () => {
    tieneAlgunFactorMock.mockResolvedValue(false);
    gastarCodigo.mockResolvedValue(true);
    const c = callStepup({ codigo: "B".repeat(26) });
    await stepup(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    expect(gastarCodigo).not.toHaveBeenCalled();
    expect(sesionUpdate).not.toHaveBeenCalled();
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
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

  it("does not charge failed_attempts for a crypto failure either — hallazgo F5/A5/C-4", async () => {
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    const filaSana = filaTotp(1, ID_USUARIO);
    const tagRoto = Buffer.from(filaSana.auth_tag);
    tagRoto[0] ^= 0xff;
    filas = [{ ...filaSana, auth_tag: tagRoto }];

    const c = callStepup({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
    await stepup(c.req, c.res);

    expect(c.status).toBe(400);
    expect(increment).not.toHaveBeenCalled();
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

  describe("the countdown before the account locks (plan 4D, tarea 2)", () => {
    // 🔴 Why this exists at all. Five wrong codes lock the whole ERP account,
    // and every way of failing answers the same sentence. Once locked, the
    // *login* answers "Usuario o contraseña incorrectos" — indistinguishable
    // from a mistyped password. So somebody whose phone clock has drifted goes
    // from "my code does not work" to "I cannot log in", never reads a
    // warning, and the button that lifts the lock is one an administrator has
    // to press. This number is the whole of what stands between those two.

    it("says how many guesses are left after a wrong code", async () => {
      // The database already added one, so `failed_attempts: 1` means this
      // failure was the first.
      findOneUsuario.mockResolvedValue({ dataValues: { failed_attempts: 1 } });

      const c = callStepup({ codigo: "000000" });
      await stepup(c.req, c.res);

      expect(c.status).toBe(400);
      expect(c.payload).toMatchObject({
        message: CODIGO_MFA_INVALIDO,
        intentosRestantes: LOCKOUT_AFTER_FAILURES - 1,
      });
    });

    it("says zero on the failure that locks it, not one", async () => {
      findOneUsuario.mockResolvedValue({
        dataValues: { failed_attempts: LOCKOUT_AFTER_FAILURES },
      });

      const c = callStepup({ codigo: "000000" });
      await stepup(c.req, c.res);

      expect(c.payload).toMatchObject({
        intentosRestantes: 0,
      });
    });

    it("says zero to an account that is already locked", async () => {
      // Same sentence a wrong code gets — a locked account is never confirmed
      // to somebody probing — but zero tells the person who has been typing
      // correct codes that trying again is not the remedy.
      findByPk.mockResolvedValue({
        dataValues: {
          failed_attempts: LOCKOUT_AFTER_FAILURES,
          locked_until: new Date(Date.now() + 60_000),
        },
      });

      const c = callStepup({ codigo: "000000" });
      await stepup(c.req, c.res);

      expect(c.status).toBe(400);
      expect(c.payload).toMatchObject({
        message: CODIGO_MFA_INVALIDO,
        intentosRestantes: 0,
      });
    });

    it("still reports a countdown when the failure was the server's, and does not charge one", async () => {
      // 🔴 Este test afirmaba lo contrario, y estaba mal.
      //
      // Decía que un fallo criptográfico no debía llevar cuenta atrás, porque
      // no se carga nada. Cierto lo segundo, equivocado lo primero: un campo
      // que aparece en unas respuestas y falta en otras **es** la señal que
      // distingue «tu código está mal» de «el servidor no puede leer tu
      // secreto», y hay un test desde el 4B cuyo trabajo es que no exista esa
      // señal. Lo que se responde es el contador tal y como está, sin
      // incrementarlo.
      const fila = filaTotp(1, ID_USUARIO);
      const tagRoto = Buffer.from(fila.auth_tag);
      tagRoto[0] ^= 0xff;
      filas = [{ ...fila, auth_tag: tagRoto }];
      const secret = OTPAuth.Secret.fromBase32(SECRETO);
      const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });

      const c = callStepup({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
      await stepup(c.req, c.res);

      expect(c.status).toBe(400);
      // Presente, como en cualquier otro fallo: la forma no delata nada.
      expect(c.payload).toHaveProperty("intentosRestantes");
      // Y lo que importaba del test original sigue en pie: no se cobra.
      expect(increment).not.toHaveBeenCalled();
    });
  });

});

// ───────────────────────── Plan 4E: `metodo` and the email-code arm ─────────────────────────

describe("the `metodo` field (plan 4E)", () => {
  it("without it, six digits still go to the TOTP arm — no client in flight changes behaviour", async () => {
    const secret = OTPAuth.Secret.fromBase32(SECRETO);
    const counter = OTPAuth.TOTP.counter({ timestamp: Date.now() });
    filas = [filaTotp(1, ID_USUARIO)];
    const c = call({ codigo: OTPAuth.HOTP.generate({ secret, counter }) });
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(cobrarIntento).not.toHaveBeenCalled();
    expect(gastarCodigo).not.toHaveBeenCalled();
  });

  it("refuses an unknown value before spending anything", async () => {
    const c = call({ codigo: "123456", metodo: "passkey" });
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(METODO_DESCONOCIDO);
    expect(cobrarIntento).not.toHaveBeenCalled();
    expect(gastarCodigo).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(sesionUpdate).not.toHaveBeenCalled();
  });

  it("with metodo: codigo, six digits go to the recovery arm — guard first, then the shape refusal", async () => {
    const c = call({ codigo: "123456", metodo: "codigo" });
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(tieneAlgunFactorMock).toHaveBeenCalledWith(ID_USUARIO);
    expect(gastarCodigo).toHaveBeenCalledWith(ID_USUARIO, "123456", { transaction: { id: "tx" } });
    expect(cobrarIntento).not.toHaveBeenCalled();
  });

  it("with metodo: codigo and no factor, the guard still refuses without spending — however the arm was reached", async () => {
    tieneAlgunFactorMock.mockResolvedValue(false);
    const c = call({ codigo: "123456", metodo: "codigo" });
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(gastarCodigo).not.toHaveBeenCalled();
  });

  it("with metodo: totp, a 26-character string goes to the TOTP arm and fails there, never to the recovery arm", async () => {
    filas = [filaTotp(1, ID_USUARIO)];
    const c = call({ codigo: "A".repeat(26), metodo: "totp" });
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(gastarCodigo).not.toHaveBeenCalled();
    expect(cobrarIntento).not.toHaveBeenCalled();
  });
});

describe("POST /auth/mfa/verify with metodo: correo (plan 4E)", () => {
  const conCorreo = (codigo = "123456", extra: Record<string, unknown> = {}) =>
    call({ codigo, metodo: "correo", ...extra });

  it("charges the attempt, compares, spends and promotes — in that order, and promotes as `correo`", async () => {
    const orden: string[] = [];
    cobrarIntento.mockImplementation(async () => {
      orden.push("cobrar");
      return { id: 31, codigo_hash: "hash(123456)" };
    });
    bcryptCompare.mockImplementation(async (t: string, h: string) => {
      orden.push("compare");
      return h === `hash(${t})`;
    });
    liquidarCodigo.mockImplementation(async () => {
      orden.push("liquidar");
      return true;
    });
    sesionUpdate.mockImplementation(async () => {
      orden.push("promover");
      return [1];
    });
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(orden).toEqual(["cobrar", "compare", "liquidar", "promover"]);
    expect(cobrarIntento).toHaveBeenCalledWith(ID_USUARIO);
    expect(liquidarCodigo).toHaveBeenCalledWith(31, { transaction: { id: "tx" } });
    const [valores, opciones] = sesionUpdate.mock.calls[0] as [Record<string, unknown>, { transaction?: unknown }];
    expect(valores).toMatchObject({ estado: "completa", mfa_source: "correo" });
    expect(opciones.transaction).toEqual({ id: "tx" });
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MFA_VERIFIED", metadata: expect.objectContaining({ fuente: "correo" }) }),
    );
  });

  // 🔴 An audit of the first draft: the fifth attempt is the one that burns
  // the row, and spending it again found that burn and called it a loss —
  // the correct fifth code answered "wrong" and locked the account on it.
  it("seals on a correct last-allowed attempt without spending the row the charge already burned", async () => {
    cobrarIntento.mockResolvedValue({ id: 31, codigo_hash: "hash(123456)", agotado: true });
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(liquidarCodigo).not.toHaveBeenCalled();
    expect(sesionUpdate).toHaveBeenCalledTimes(1);
    expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: "MFA_VERIFIED" }));
  });

  it("still spends the row on every attempt before the last", async () => {
    cobrarIntento.mockResolvedValue({ id: 31, codigo_hash: "hash(123456)", agotado: false });
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(liquidarCodigo).toHaveBeenCalledWith(31, { transaction: { id: "tx" } });
  });

  it("clears previous failures on success, like the other arms", async () => {
    findByPk.mockResolvedValue({ dataValues: { failed_attempts: 3, locked_until: null } });
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(updateUsuario).toHaveBeenCalled();
  });

  it("seals instead when there was nothing to promote — a completa session under the grace clock", async () => {
    sesionUpdate.mockResolvedValueOnce([0]).mockResolvedValueOnce([1]);
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(sesionUpdate).toHaveBeenCalledTimes(2);
    const [valores] = sesionUpdate.mock.calls[1] as [Record<string, unknown>];
    expect(valores).toMatchObject({ mfa_source: "correo" });
    expect(valores).not.toHaveProperty("estado");
  });

  it("rolls the spend back and answers the uniform 400 when neither write finds a session", async () => {
    sesionUpdate.mockResolvedValue([0]);
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    // Spent inside the transaction that then unwound — the same shape the
    // recovery-code arm has, so the code stays usable.
    expect(liquidarCodigo).toHaveBeenCalledWith(31, { transaction: { id: "tx" } });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("answers the uniform 400 and charges the lockout on a wrong code, with the countdown", async () => {
    const c = conCorreo("654321");
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    expect(c.payload).toHaveProperty("intentosRestantes");
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
    expect(liquidarCodigo).not.toHaveBeenCalled();
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MFA_VERIFY_FAILED", detail: expect.stringContaining("por correo") }),
    );
  });

  // 🔴 Uniformity in time as well as in the answer: "no code" costs a compare.
  it("compares against the filler hash when no live code exists, so the timing does not say so", async () => {
    cobrarIntento.mockResolvedValue(null);
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    const [, hash] = bcryptCompare.mock.calls[0] as [string, string];
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(increment).toHaveBeenCalled();
  });

  it("refuses a code that is not six digits before charging or comparing", async () => {
    const c = conCorreo("A".repeat(26));
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
    expect(cobrarIntento).not.toHaveBeenCalled();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it("answers 429 when the account's verification bucket is full, before touching the database", async () => {
    admitirIntentoDeCorreo.mockReturnValue(false);
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(429);
    expect(c.message).toBe(DEMASIADOS_INTENTOS_CORREO);
    expect(admitirIntentoDeCorreo).toHaveBeenCalledWith(ID_USUARIO);
    expect(cobrarIntento).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
  });

  it("does not consult the recovery-code guard: an email code is not a recovery code", async () => {
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(gastarCodigo).not.toHaveBeenCalled();
  });

  it("still refuses a locked account first, spending nothing", async () => {
    findByPk.mockResolvedValue({ dataValues: { failed_attempts: 5, locked_until: new Date(Date.now() + 60_000) } });
    const c = conCorreo();
    await verify(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.payload).toEqual({ message: CODIGO_MFA_INVALIDO, intentosRestantes: 0 });
    expect(cobrarIntento).not.toHaveBeenCalled();
  });

  it("can remember the device, like the other arms", async () => {
    const c = conCorreo("123456", { recordar: true });
    await verify(c.req, c.res);
    expect(c.status).toBe(200);
    expect(acunarDispositivo).toHaveBeenCalled();
  });
});

describe("POST /auth/stepup with metodo: correo (plan 4E)", () => {
  const stepupConCorreo = (codigo = "123456", estado = "completa") =>
    call({ codigo, metodo: "correo" }, usuarioAutenticado({ estado, mfa_satisfied_at: null }));

  it("re-seals a live complete session through the state-filtered UPDATE, on the transaction", async () => {
    const c = stepupConCorreo();
    await stepup(c.req, c.res);
    expect(c.status).toBe(200);
    expect(liquidarCodigo).toHaveBeenCalledWith(31, { transaction: { id: "tx" } });
    const [valores, opciones] = sesionUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown>; transaction?: unknown },
    ];
    expect(valores.mfa_source).toBe("correo");
    expect(valores).not.toHaveProperty("estado");
    expect(opciones.where).toMatchObject({ id: ID_SESION, id_usuario: ID_USUARIO, estado: "completa" });
    expect(opciones.transaction).toEqual({ id: "tx" });
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_REPROVED", metadata: expect.objectContaining({ fuente: "correo" }) }),
    );
  });

  it("does not let a parcial session seal itself through the step-up door", async () => {
    // The fake reads the `where`: a seal that dropped the state filter would
    // find this parcial session, and a canned `[0]` would never notice.
    sesionUpdate.mockImplementation(async (_valores: unknown, opciones: { where: Record<string, unknown> }) =>
      opciones.where.estado === "completa" ? [0] : [1],
    );
    const c = stepupConCorreo("123456", "parcial");
    await stepup(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CODIGO_MFA_INVALIDO);
  });

  it("answers 429 from the same bucket as verify", async () => {
    admitirIntentoDeCorreo.mockReturnValue(false);
    const c = stepupConCorreo();
    await stepup(c.req, c.res);
    expect(c.status).toBe(429);
    expect(cobrarIntento).not.toHaveBeenCalled();
  });

  it("charges the lockout on a wrong code, with its own detail", async () => {
    const c = stepupConCorreo("000000");
    await stepup(c.req, c.res);
    expect(c.status).toBe(400);
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: ID_USUARIO } });
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MFA_VERIFY_FAILED", detail: expect.stringContaining("step-up por correo") }),
    );
  });

  it("refuses an unknown metodo before spending anything", async () => {
    const c = call({ codigo: "123456", metodo: "sms" }, usuarioAutenticado({ estado: "completa", mfa_satisfied_at: null }));
    await stepup(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(METODO_DESCONOCIDO);
    expect(cobrarIntento).not.toHaveBeenCalled();
    expect(sesionUpdate).not.toHaveBeenCalled();
  });
});
