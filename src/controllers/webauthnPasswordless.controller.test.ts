// The passwordless door — plan 4C phase 2, Tasks 12-14 — under test with the
// models faked and the decisions real.
//
// **What is mocked and what is not, and why the split matters more here than
// anywhere else in this arc.** `webauthn.controller.test.ts` fakes
// `factorInventory.js` wholesale, which is fine for the ceremonies it covers
// and would be blinding here: the one property phase 2 adds to that module —
// `"passkey"` opening `completa` — would then be asserted against a stub that
// answers whatever the test says. So this file fakes the three factor
// *tables* and the session *store*, and keeps `estadoInicialDeSesion`,
// `terminarLogin` and `issueSession` real: the state is decided by the real
// rule over fake rows, the session is issued by the real code over a fake
// insert, and the cookie is set by the real helper on a fake response. The
// same split `login.session.test.ts` makes, for the same reason.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const generateAuthenticationOptions = vi.fn();
const verifyAuthenticationResponse = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: (...a: unknown[]) => generateAuthenticationOptions(...a),
  verifyAuthenticationResponse: (...a: unknown[]) => verifyAuthenticationResponse(...a),
}));

const guardarReto = vi.fn();
const consumirReto = vi.fn();
const purgarRetosCaducados = vi.fn();
vi.mock("../auth/retoStore.js", () => ({
  guardarReto: (...a: unknown[]) => guardarReto(...a),
  consumirReto: (...a: unknown[]) => consumirReto(...a),
  purgarRetosCaducados: (...a: unknown[]) => purgarRetosCaducados(...a),
}));

const buscarCredencialPorId = vi.fn();
const marcarCredencialUsada = vi.fn();
// `esContadorDeClon` stays real, as in the phase-1 file: the clone branch is
// reached by the numbers actually meeting. `buscarCredencialPorId` is named
// explicitly — a spread that let the real one through would reach the fake
// model below and get a plausible row with no key on it.
vi.mock("../auth/passkeyStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/passkeyStore.js")>()),
  buscarCredencialDe: vi.fn(),
  buscarCredencialPorId: (...a: unknown[]) => buscarCredencialPorId(...a),
  marcarCredencialUsada: (...a: unknown[]) => marcarCredencialUsada(...a),
}));

const usuarioFindByPk = vi.fn();
const usuarioUpdate = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findByPk: (...a: unknown[]) => usuarioFindByPk(...a),
    update: (...a: unknown[]) => usuarioUpdate(...a),
  },
}));

// The three factor tables, as counts: `estadoInicialDeSesion` is real and asks
// them. They also cannot be left alone — each model calls `UsuarioModel.hasMany`
// as it loads, on the stub above, which has no such method.
const passkeyCount = vi.fn();
const totpCount = vi.fn();
vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: { count: (...a: unknown[]) => passkeyCount(...a) },
}));
vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: { count: (...a: unknown[]) => totpCount(...a) },
}));
vi.mock("../models/codigoRecuperacion.model.js", () => ({
  CodigoRecuperacionModel: { count: vi.fn() },
}));

const createSession = vi.fn();
const findLiveSession = vi.fn();
const revokeSessionOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  findLiveSession: (...a: unknown[]) => findLiveSession(...a),
  revokeSessionOf: (...a: unknown[]) => revokeSessionOf(...a),
  revokeAllSessionsOf: vi.fn(),
  listSessionsOf: vi.fn(),
}));
// Reached through the phase-1 controller this one imports a constant from;
// none of them is called here, and each would pull a model that calls
// `UsuarioModel.hasMany` on the stub.
vi.mock("../auth/sessionPromotion.js", () => ({
  promoverSesion: vi.fn(),
  sellarPruebaDeFactor: vi.fn(),
  apagarLaMecha: vi.fn(),
}));
vi.mock("../auth/rememberedDeviceStore.js", () => ({ revokeAllRememberedDevicesOf: vi.fn() }));
vi.mock("../auth/recoveryCodeStore.js", () => ({
  contarCodigosRestantes: vi.fn(),
  prepararCodigos: vi.fn(),
  escribirCodigos: vi.fn(),
}));
const purgeExpiredTokens = vi.fn();
vi.mock("../auth/tokenStore.js", () => ({
  purgeExpiredTokens: (...a: unknown[]) => purgeExpiredTokens(...a),
}));

const TRANSACCION = { id: "una-transaccion" };
const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(TRANSACCION));
vi.mock("../database/sequelize.js", () => ({
  sequelize: {
    transaction: (...a: unknown[]) => transaction(...(a as [(t: unknown) => Promise<unknown>])),
  },
}));

const permissionsFor = vi.fn();
vi.mock("../permissions/store.js", () => ({
  permissionsFor: (...a: unknown[]) => permissionsFor(...a),
}));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
const warn = vi.fn();
const error = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ error, warn, info: vi.fn(), debug: vi.fn() }),
}));

const { passwordlessOptions, passwordlessVerify, MENSAJE_LOGIN_LLAVE, WEBAUTHN_ASSERTION_FLOOD } =
  await import("./webauthnPasswordless.controller.js");
const { WEBAUTHN_ASSERTION_FAILED } = await import("./webauthn.controller.js");
const { SESION_NO_DISPONIBLE, LOGIN_OK } = await import("../auth/finishLogin.js");
const { olvidarFallosAnonimos } = await import("../auth/failedAssertionBudget.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");
const { SESSION_EXPIRES_HEADER, WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT } = await import(
  "../config/security.js"
);

const ANA = 42;
const CREDENCIAL = {
  id: 7,
  id_usuario: ANA,
  credential_id: "credencial-base64url",
  public_key: Buffer.from([1, 2, 3]),
  // A string, as `pg` hands a BIGINT back.
  counter: "5",
};
const CUENTA = {
  dataValues: {
    id: ANA,
    id_rol: 2,
    user: "ana",
    name: "Ana",
    lastname: "Pérez",
    image: null,
    mfa_grace_until: null as Date | null,
  },
};
const PERMISOS = { poste: { ver: true } };
const TOKEN = "un-token-opaco";
const CADUCA = new Date("2026-09-10T00:00:00.000Z");

function respuestaFalsa() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    setHeader: vi.fn(),
    removeHeader: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const peticion = (body: unknown = {}, cookies?: Record<string, string>) =>
  ({ body, cookies, ip: "10.0.0.1", headers: { "user-agent": "TestRunner" } }) as unknown as Request;

/** A verify call with the assertion the fixtures know, and whatever the test changes. */
async function verificar(body: unknown = { respuesta: { id: CREDENCIAL.credential_id } }, cookies?: Record<string, string>) {
  const res = respuestaFalsa();
  await passwordlessVerify(peticion(body, cookies), res as unknown as Response);
  return res;
}

const lineas = (accion: string) =>
  logAction.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((l) => l.action === accion);

/**
 * The library as it behaves when the assertion is good: it calls
 * `expectedChallenge` itself and throws if that says no. Named so the tests
 * that first arm a rejection can put it back — `vi.clearAllMocks()` forgets
 * calls, not implementations.
 */
function libreriaAcepta() {
  verifyAuthenticationResponse.mockImplementation(async (opts: Record<string, unknown>) => {
    const comprobar = opts.expectedChallenge as (c: string) => Promise<boolean> | boolean;
    const vale = await comprobar("reto-de-login");
    if (!vale) throw new Error("challenge rechazado");
    return {
      verified: true,
      authenticationInfo: { newCounter: 6, credentialDeviceType: "multiDevice", credentialBackedUp: true },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  olvidarFallosAnonimos(ANA);
  process.env.WEBAUTHN_RP_ID = "www.osefi.net";
  process.env.WEBAUTHN_ORIGIN = "https://www.osefi.net";

  generateAuthenticationOptions.mockResolvedValue({ challenge: "reto-de-login" });
  guardarReto.mockResolvedValue(undefined);
  purgarRetosCaducados.mockResolvedValue(0);
  consumirReto.mockResolvedValue({ id_usuario: null, id_sesion: null });
  buscarCredencialPorId.mockResolvedValue(CREDENCIAL);
  marcarCredencialUsada.mockResolvedValue(true);
  usuarioFindByPk.mockResolvedValue(CUENTA);
  usuarioUpdate.mockResolvedValue([1]);
  // Ana has the passkey she is logging in with, and nothing else.
  passkeyCount.mockResolvedValue(1);
  totpCount.mockResolvedValue(0);
  createSession.mockResolvedValue({ token: TOKEN, expiresAt: CADUCA, id: "sesion-de-ana" });
  findLiveSession.mockResolvedValue(null);
  revokeSessionOf.mockResolvedValue(true);
  permissionsFor.mockResolvedValue(PERMISOS);
  purgeExpiredTokens.mockResolvedValue(0);
  logAction.mockResolvedValue(undefined);
  // The library calls `expectedChallenge` itself; the fake has to do the same
  // or the redemption never runs and the replay tests below would pass against
  // a controller that never checks the challenge at all.
  libreriaAcepta();
});

describe("passwordlessOptions — a challenge for nobody in particular", () => {
  it("reads nothing from the request: the same work whoever asks, and whatever they send", async () => {
    // 🔴 The oracle the plan warns about is an endpoint that takes a username
    // and answers with that account's credentials. This one does the same
    // single write for an empty body, a real name and a made-up one.
    for (const body of [{}, { user: "ana" }, { user: "nadie" }]) {
      guardarReto.mockClear();
      const res = respuestaFalsa();
      await passwordlessOptions(peticion(body), res as unknown as Response);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(guardarReto, JSON.stringify(body)).toHaveBeenCalledTimes(1);
      expect(usuarioFindByPk, JSON.stringify(body)).not.toHaveBeenCalled();
      expect(buscarCredencialPorId, JSON.stringify(body)).not.toHaveBeenCalled();
    }
  });

  it("names no credential and demands a verified user", async () => {
    await passwordlessOptions(peticion(), respuestaFalsa() as unknown as Response);
    const opts = generateAuthenticationOptions.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.allowCredentials).toEqual([]);
    expect(opts.userVerification).toBe("required");
    expect(opts.rpID).toBe("www.osefi.net");
  });

  it("writes the challenge down with no owner, no session, and the login purpose — the whole tuple", async () => {
    await passwordlessOptions(peticion(), respuestaFalsa() as unknown as Response);
    // `toStrictEqual`, because `{ id_usuario: undefined }` would be dropped by
    // Sequelize and read as equal to `{}` by `toEqual`.
    expect(guardarReto.mock.calls[0]).toStrictEqual([
      "reto-de-login",
      "login",
      { id_usuario: null, id_sesion: null },
    ]);
  });

  it("hands the options back as the library built them", async () => {
    const res = respuestaFalsa();
    await passwordlessOptions(peticion(), res as unknown as Response);
    expect(res.body).toEqual({ challenge: "reto-de-login" });
  });

  it("purges expired challenges, and still answers when the purge fails", async () => {
    purgarRetosCaducados.mockRejectedValue(new Error("no"));
    const res = respuestaFalsa();
    await passwordlessOptions(peticion(), res as unknown as Response);
    await new Promise((r) => setImmediate(r));
    expect(purgarRetosCaducados).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(error).toHaveBeenCalled();
  });
});

describe("passwordlessVerify — every refusal looks the same from outside", () => {
  const RECHAZO = { status: 400, body: { message: MENSAJE_LOGIN_LLAVE } };

  /**
   * The eight ways in, each preparing its own refusal. The loop arms the
   * library to reject before every path, so the ones that must be refused
   * *before* the signature cannot pass by reaching it; the paths past the
   * signature put the accepting library back themselves.
   */
  const CAMINOS: Array<[string, () => Promise<unknown>]> = [
    ["a body with no assertion", () => verificar({})],
    ["an assertion whose id is not a string", () => verificar({ respuesta: { id: 7 } })],
    ["an id longer than any credential of ours", () => verificar({ respuesta: { id: "x".repeat(1365) } })],
    [
      "a credential this ERP has never seen",
      () => {
        buscarCredencialPorId.mockResolvedValue(null);
        return verificar();
      },
    ],
    [
      "an account that has been archived",
      () => {
        libreriaAcepta();
        usuarioFindByPk.mockResolvedValue(null);
        return verificar();
      },
    ],
    [
      "a signature the library refused",
      () => {
        verifyAuthenticationResponse.mockRejectedValue(new Error("firma"));
        return verificar();
      },
    ],
    [
      "an assertion the library answered unverified",
      () => {
        verifyAuthenticationResponse.mockResolvedValue({ verified: false });
        return verificar();
      },
    ],
    [
      "a credential deleted while the ceremony was in flight",
      () => {
        libreriaAcepta();
        marcarCredencialUsada.mockResolvedValue(false);
        return verificar();
      },
    ],
    [
      "an account found with no factor left",
      () => {
        libreriaAcepta();
        passkeyCount.mockResolvedValue(0);
        return verificar();
      },
    ],
  ];

  it("answers the same status and the same sentence, whole, on every path", async () => {
    for (const [nombre, camino] of CAMINOS) {
      vi.clearAllMocks();
      olvidarFallosAnonimos(ANA);
      buscarCredencialPorId.mockResolvedValue(CREDENCIAL);
      usuarioFindByPk.mockResolvedValue(CUENTA);
      marcarCredencialUsada.mockResolvedValue(true);
      verifyAuthenticationResponse.mockRejectedValue(new Error("no debería llegar aquí"));
      const res = (await camino()) as ReturnType<typeof respuestaFalsa>;
      expect({ status: res.statusCode, body: res.body }, nombre).toEqual(RECHAZO);
      passkeyCount.mockResolvedValue(1);
      // And opens nothing: no row, no cookie, no header, no login line.
      expect(createSession, nombre).not.toHaveBeenCalled();
      expect(res.cookie, nombre).not.toHaveBeenCalled();
      expect(lineas("LOGIN"), nombre).toEqual([]);
      expect(lineas("MFA_VERIFIED"), nombre).toEqual([]);
    }
  });

  it("refuses a malformed body before touching the database", async () => {
    // The over-long id is the case that a shorter guard drops: refused later
    // anyway, by the signature, so only "was the lookup reached" tells the
    // two apart — and the lookup is a `WHERE` against a unique index on an
    // anonymous endpoint.
    for (const body of [{}, { respuesta: { id: "" } }, { respuesta: { id: 7 } }, { respuesta: { id: "x".repeat(1365) } }]) {
      vi.clearAllMocks();
      await verificar(body);
      expect(buscarCredencialPorId, JSON.stringify(body).slice(0, 40)).not.toHaveBeenCalled();
      expect(logAction, JSON.stringify(body).slice(0, 40)).not.toHaveBeenCalled();
    }
  });

  it("writes no bitácora line for a credential nobody owns here, but does note the address", async () => {
    buscarCredencialPorId.mockResolvedValue(null);
    await verificar();
    expect(logAction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ ip: "10.0.0.1" }, expect.stringContaining("no existe"));
  });
});

describe("passwordlessVerify — the account behind the credential", () => {
  it("reads the account the credential names, paranoid and by the columns it publishes", async () => {
    await verificar();
    expect(usuarioFindByPk).toHaveBeenCalledWith(ANA, {
      attributes: ["id", "id_rol", "user", "name", "lastname", "image", "mfa_grace_until"],
    });
  });

  // 🔴 `deleteUsuario` leaves `credencial_webauthn` alone so un-archiving
  // restores the factors — so an archived ex-employee keeps a passkey that
  // verifies. The paranoid read is what stops it logging in — read AFTER the
  // signature, so that an archived account and a live one with a bad
  // signature do the same work and answer in the same time, and so that the
  // challenge is spent either way: read first, a captured credential id could
  // learn whether its owner still works here from whether a second redemption
  // of the same challenge went through.
  it("refuses an archived account after verifying, with the challenge spent, and files it under that account", async () => {
    usuarioFindByPk.mockResolvedValue(null);
    await verificar();
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
    expect(consumirReto).toHaveBeenCalledTimes(1);
    expect(marcarCredencialUsada).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(lineas(WEBAUTHN_ASSERTION_FAILED)).toEqual([
      expect.objectContaining({
        id_usuario: ANA,
        entity: "credencial_webauthn",
        entity_id: 7,
        metadata: { id_sesion: null, ceremonia: "login", motivo: "cuenta-archivada" },
        severity: "warning",
      }),
    ]);
  });

  it("does not consult the lockout: a locked account still enters by key", async () => {
    // Phase 1's decision, inherited on purpose: the lockout defends a
    // guessable secret. Refusing here would let five wrong passwords from
    // anywhere shut a colleague's key. The column is not even read —
    // see the attributes assertion above — so this pins the outcome.
    usuarioFindByPk.mockResolvedValue({
      dataValues: { ...CUENTA.dataValues, locked_until: new Date(Date.now() + 60_000), failed_attempts: 9 },
    });
    const res = await verificar();
    expect(res.statusCode).toBe(200);
    expect(usuarioUpdate).not.toHaveBeenCalled();
  });
});

describe("passwordlessVerify — the challenge", () => {
  it("spends it for the login purpose with no session, inside the verification", async () => {
    await verificar();
    // `toStrictEqual`: `{ id_sesion: undefined }` would drop the condition
    // from the WHERE and let a session-bound challenge be spent here.
    expect(consumirReto.mock.calls[0]).toStrictEqual(["reto-de-login", "login", { id_sesion: null }]);
    expect(consumirReto.mock.invocationCallOrder[0]).toBeGreaterThan(
      verifyAuthenticationResponse.mock.invocationCallOrder[0],
    );
  });

  // 🔴 The mutation that compiles: `expectedChallenge: (c) => consumirReto(...) !== null`
  // with the `await` dropped. A promise is never null, every replay passes,
  // and for a synced passkey nothing else stands behind this check.
  it("refuses an assertion whose challenge cannot be spent — spent, expired, or never minted", async () => {
    consumirReto.mockResolvedValue(null);
    const res = await verificar();
    expect(res.statusCode).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    expect(lineas(WEBAUTHN_ASSERTION_FAILED)[0]?.metadata).toMatchObject({ motivo: "verificacion-rechazada" });
  });

  it("checks origin and relying party, and demands a verified user", async () => {
    await verificar();
    const opts = verifyAuthenticationResponse.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.expectedOrigin).toEqual(["https://www.osefi.net"]);
    expect(opts.expectedRPID).toBe("www.osefi.net");
    expect(opts.requireUserVerification).toBe(true);
    expect(opts.credential).toMatchObject({ id: CREDENCIAL.credential_id, counter: 5 });
  });

  it("files a counter that went backwards as critical, and refuses", async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 4, credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    const res = await verificar();
    expect(res.statusCode).toBe(400);
    expect(lineas("WEBAUTHN_COUNTER_REGRESSION")).toEqual([
      expect.objectContaining({ id_usuario: ANA, entity_id: 7, severity: "critical" }),
    ]);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("passwordlessVerify — opening the session, and the race it must lose correctly", () => {
  it("marks the credential and opens the session in one transaction, the mark first", async () => {
    await verificar();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(marcarCredencialUsada).toHaveBeenCalledWith(7, 6, { transaction: TRANSACCION });
    expect(createSession).toHaveBeenCalledWith(
      ANA,
      { userAgent: "TestRunner", ip: "10.0.0.1" },
      "completa",
      "passkey",
      { transaction: TRANSACCION },
    );
    expect(marcarCredencialUsada.mock.invocationCallOrder[0]).toBeLessThan(
      createSession.mock.invocationCallOrder[0],
    );
  });

  // 🔴 The deletion went first: the mark matched nothing, so the session
  // must not be opened — it would be inserted after the deleter's revocation
  // and survive it, sealed, for thirty days, on an account with no factor.
  it("refuses when the credential was deleted under the ceremony, and opens nothing", async () => {
    marcarCredencialUsada.mockResolvedValue(false);
    const res = await verificar();
    expect(res.statusCode).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
    expect(lineas(WEBAUTHN_ASSERTION_FAILED)[0]?.metadata).toMatchObject({
      motivo: "credencial-borrada-durante-la-ceremonia",
    });
  });

  // The second witness: the real `estadoInicialDeSesion` counting the
  // account's factors. Nothing registered means the credential is gone, and
  // the answer would otherwise be `completa` plus a fresh fourteen-day clock.
  it("refuses when the account turns out to have no factor left, and starts no grace clock", async () => {
    passkeyCount.mockResolvedValue(0);
    const res = await verificar();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: MENSAJE_LOGIN_LLAVE });
    expect(createSession).not.toHaveBeenCalled();
    expect(usuarioUpdate).not.toHaveBeenCalled();
    expect(lineas(WEBAUTHN_ASSERTION_FAILED)[0]?.metadata).toMatchObject({ motivo: "factor-desaparecido" });
  });

  it("opens the session completa, from the real rule over the account's own factors", async () => {
    const res = await verificar();
    expect(res.statusCode).toBe(200);
    expect(passkeyCount).toHaveBeenCalledWith({ where: { id_usuario: ANA }, transaction: TRANSACCION });
    expect(createSession.mock.calls[0][2]).toBe("completa");
  });

  // 🔴 A transaction holds one pool connection; a query issued around it
  // borrows a second. Fifteen logins at once on a pool of fifteen would each
  // hold one and wait for another until the acquire timeout — for the whole
  // API. So every query inside the callback has to carry the transaction:
  // the two counts, the rotation's read and write, and the insert.
  it("runs every query of the login on the transaction's own connection", async () => {
    findLiveSession.mockResolvedValue({ id: "la-anterior", id_usuario: 99 });
    await verificar(undefined, { [SESSION_COOKIE_NAME]: "cookie-anterior" });
    expect(passkeyCount.mock.calls[0][0]).toMatchObject({ transaction: TRANSACCION });
    expect(totpCount.mock.calls[0][0]).toMatchObject({ transaction: TRANSACCION });
    expect(findLiveSession).toHaveBeenCalledWith("cookie-anterior", { transaction: TRANSACCION });
    expect(revokeSessionOf).toHaveBeenCalledWith(99, "la-anterior", { transaction: TRANSACCION });
    expect(createSession.mock.calls[0][4]).toEqual({ transaction: TRANSACCION });
  });

  it("answers 503 with the session sentence when the row cannot be written, and sets no cookie", async () => {
    createSession.mockRejectedValue(new Error("pool agotado"));
    const res = await verificar();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ message: SESION_NO_DISPONIBLE });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(lineas("LOGIN")).toEqual([]);
    // Rolled back: the transaction callback rejected.
    await expect(transaction.mock.results[0].value).rejects.toThrow();
  });

  it("takes the cookie back when the commit itself fails after the row was written", async () => {
    transaction.mockImplementationOnce(async (cb) => {
      await cb(TRANSACCION);
      throw new Error("commit failed");
    });
    const res = await verificar();
    expect(res.statusCode).toBe(500);
    expect(res.cookie).toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalled();
    expect(res.removeHeader).toHaveBeenCalledWith(SESSION_EXPIRES_HEADER);
    expect(lineas("LOGIN")).toEqual([]);
  });

  it("closes the session this browser was already holding, and only after the assertion verified", async () => {
    findLiveSession.mockResolvedValue({ id: "la-anterior", id_usuario: 99 });
    const res = await verificar(undefined, { [SESSION_COOKIE_NAME]: "cookie-anterior" });
    expect(res.statusCode).toBe(200);
    expect(revokeSessionOf).toHaveBeenCalledWith(99, "la-anterior", { transaction: TRANSACCION });
    expect(revokeSessionOf.mock.invocationCallOrder[0]).toBeGreaterThan(
      verifyAuthenticationResponse.mock.invocationCallOrder[0],
    );
  });

  it("revokes nothing on a failed assertion, whatever cookie came with it", async () => {
    // A shared PC: somebody else's session in the browser, a passkey that
    // fails. Their session must survive.
    findLiveSession.mockResolvedValue({ id: "la-anterior", id_usuario: 99 });
    verifyAuthenticationResponse.mockRejectedValue(new Error("firma"));
    await verificar(undefined, { [SESSION_COOKIE_NAME]: "cookie-anterior" });
    expect(findLiveSession).not.toHaveBeenCalled();
    expect(revokeSessionOf).not.toHaveBeenCalled();
  });
});

describe("passwordlessVerify — what a finished login answers and leaves behind", () => {
  it("answers the same body a password login does: the person, the matrix, the sentence", async () => {
    const res = await verificar();
    expect(res.body).toEqual({
      usuario: { id: ANA, id_rol: 2, user: "ana", name: "Ana", lastname: "Pérez", image: null },
      permisos: PERMISOS,
      message: LOGIN_OK,
    });
  });

  // 🔴 The matrix loader refreshes its cache on the pool with no transaction:
  // read inside the login's transaction it would be the one query still
  // borrowing a second connection while the first sits waiting.
  it("reads the permission matrix only after the transaction has committed", async () => {
    let dentro = false;
    let leidaDentro = 0;
    transaction.mockImplementationOnce(async (cb) => {
      dentro = true;
      try {
        return await cb(TRANSACCION);
      } finally {
        dentro = false;
      }
    });
    permissionsFor.mockImplementation(async () => {
      if (dentro) leidaDentro += 1;
      return PERMISOS;
    });
    const res = await verificar();
    expect(res.statusCode).toBe(200);
    expect(permissionsFor).toHaveBeenCalledTimes(1);
    expect(leidaDentro).toBe(0);
  });

  it("keeps the grace deadline and every other column out of the body", async () => {
    usuarioFindByPk.mockResolvedValue({
      dataValues: { ...CUENTA.dataValues, mfa_grace_until: new Date(), pass: "$2a$12$hash" },
    });
    const res = await verificar();
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain("mfa_grace_until");
    expect(texto).not.toContain("$2a$12$hash");
  });

  it("hands the cookie and the expiry header over, from the real helper", async () => {
    const res = await verificar();
    expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, TOKEN, expect.objectContaining({ httpOnly: true }));
    expect(res.setHeader).toHaveBeenCalledWith(SESSION_EXPIRES_HEADER, CADUCA.toISOString());
  });

  it("writes the LOGIN line naming the method and the session, and the MFA_VERIFIED line naming the key", async () => {
    await verificar();
    expect(lineas("LOGIN")).toEqual([
      expect.objectContaining({
        id_usuario: ANA,
        metadata: { user: "ana", metodo: "passkey", id_sesion: "sesion-de-ana" },
        ip_address: "10.0.0.1",
      }),
    ]);
    expect(lineas("MFA_VERIFIED")).toEqual([
      expect.objectContaining({
        id_usuario: ANA,
        entity: "Usuario",
        entity_id: ANA,
        metadata: {
          id_sesion: "sesion-de-ana",
          fuente: "passkey",
          id_credencial: 7,
          ceremonia: "login",
          tipo: "multiDevice",
          respaldada: true,
        },
        severity: "info",
      }),
    ]);
    expect(lineas(WEBAUTHN_ASSERTION_FAILED)).toEqual([]);
  });

  it("writes both lines only once the session exists", async () => {
    await verificar();
    for (const linea of ["LOGIN", "MFA_VERIFIED"]) {
      const orden = logAction.mock.calls.findIndex((c) => (c[0] as { action: string }).action === linea);
      expect(logAction.mock.invocationCallOrder[orden], linea).toBeGreaterThan(
        createSession.mock.invocationCallOrder[0],
      );
    }
  });

  it("sweeps the single-use tokens afterwards, like the password login", async () => {
    await verificar();
    expect(purgeExpiredTokens).toHaveBeenCalled();
  });
});

describe("passwordlessVerify — the per-account ceiling on what a refusal may write", () => {
  it("writes one line per refusal up to the ceiling, then one summary, then nothing — and keeps refusing", async () => {
    verifyAuthenticationResponse.mockRejectedValue(new Error("firma"));
    const N = WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT;
    for (let i = 0; i < N + 3; i += 1) {
      const res = await verificar();
      expect(res.statusCode, `intento ${i + 1}`).toBe(400);
    }
    expect(lineas(WEBAUTHN_ASSERTION_FAILED)).toHaveLength(N);
    expect(lineas(WEBAUTHN_ASSERTION_FLOOD)).toEqual([
      expect.objectContaining({
        id_usuario: ANA,
        entity: "Usuario",
        entity_id: ANA,
        severity: "critical",
        metadata: { ceremonia: "login", motivo_ultimo: "verificacion-rechazada", id_credencial: 7 },
      }),
    ]);
    // Nothing else for the two past the summary.
    expect(logAction).toHaveBeenCalledTimes(N + 1);
  });

  // 🔴 The line the ceiling must not swallow: ten garbage assertions first,
  // then the archived ex-employee's key. That one is written once anyway.
  it("still writes the first refusal of a kind the window has not seen, past the ceiling", async () => {
    verifyAuthenticationResponse.mockRejectedValue(new Error("firma"));
    for (let i = 0; i < WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT + 2; i += 1) await verificar();
    logAction.mockClear();

    libreriaAcepta();
    usuarioFindByPk.mockResolvedValue(null);
    await verificar();
    await verificar();

    expect(lineas(WEBAUTHN_ASSERTION_FAILED)).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ motivo: "cuenta-archivada" }) }),
    ]);
  });
});
