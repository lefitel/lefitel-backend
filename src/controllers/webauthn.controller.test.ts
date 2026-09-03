// Registering a passkey: what the browser is asked for, and the six writes
// that have to happen when the answer comes back.
//
// The six are the point of this file. Each one is inherited from nothing — a
// new endpoint gets none of them for free — and each omission fails in its own
// distinct way, so each gets its own test rather than one assertion counting
// calls. `confirmTotp` does the same six for the TOTP path and its own tests
// are shaped the same way.

import { describe, it, expect, vi, beforeEach } from "vitest";

const generateRegistrationOptions = vi.fn();
const verifyRegistrationResponse = vi.fn();
const generateAuthenticationOptions = vi.fn();
const verifyAuthenticationResponse = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (...a: unknown[]) => generateRegistrationOptions(...a),
  verifyRegistrationResponse: (...a: unknown[]) => verifyRegistrationResponse(...a),
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

const buscarCredencialDe = vi.fn();
const marcarCredencialUsada = vi.fn();
// `esContadorDeClon` is deliberately **not** faked, and the absence is the
// point: it is a pure function whose whole job is a comparison, so a stub
// would only prove the controller calls something. With the real one in place,
// the clone branch below is reached by the numbers actually meeting.
vi.mock("../auth/passkeyStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/passkeyStore.js")>()),
  buscarCredencialDe: (...a: unknown[]) => buscarCredencialDe(...a),
  marcarCredencialUsada: (...a: unknown[]) => marcarCredencialUsada(...a),
}));

const promoverSesion = vi.fn();
const sellarPruebaDeFactor = vi.fn();
const apagarLaMecha = vi.fn();
vi.mock("../auth/sessionPromotion.js", () => ({
  promoverSesion: (...a: unknown[]) => promoverSesion(...a),
  sellarPruebaDeFactor: (...a: unknown[]) => sellarPruebaDeFactor(...a),
  apagarLaMecha: (...a: unknown[]) => apagarLaMecha(...a),
}));

const contarCodigosRestantes = vi.fn();
const prepararCodigos = vi.fn();
const escribirCodigos = vi.fn();
vi.mock("../auth/recoveryCodeStore.js", () => ({
  contarCodigosRestantes: (...a: unknown[]) => contarCodigosRestantes(...a),
  prepararCodigos: (...a: unknown[]) => prepararCodigos(...a),
  escribirCodigos: (...a: unknown[]) => escribirCodigos(...a),
}));

const credencialCreate = vi.fn();
const credencialFindAll = vi.fn();
const credencialFindOne = vi.fn();
const credencialDestroy = vi.fn();
vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: {
    create: (...a: unknown[]) => credencialCreate(...a),
    findAll: (...a: unknown[]) => credencialFindAll(...a),
    findOne: (...a: unknown[]) => credencialFindOne(...a),
    destroy: (...a: unknown[]) => credencialDestroy(...a),
  },
}));

const tieneAlgunFactor = vi.fn();
vi.mock("../auth/factorInventory.js", () => ({
  tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactor(...a),
}));
const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));
const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("../auth/rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...a: unknown[]) => revokeAllRememberedDevicesOf(...a),
}));

const usuarioFindByPk = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => usuarioFindByPk(...a) },
}));

// The fake invokes the callback with a fixed token standing in for the real
// transaction, so every write inside can be asserted to carry it — the same
// shape `totp.controller.test.ts` and `tokenStore.test.ts` use.
const TRANSACCION = { id: "una-transaccion" };
// A `vi.fn()` and not a bare arrow, so a test can assert it was NOT called.
// The deletion path's correctness depends on running outside any transaction
// (see `deleteCredential`), and a fake that cannot be observed lets the obvious
// "make these three writes atomic" refactor land with every test green.
const transaction = vi.fn((cb: (t: unknown) => Promise<unknown>) => cb(TRANSACCION));
vi.mock("../database/sequelize.js", () => ({
  sequelize: {
    transaction: (...a: unknown[]) => transaction(...(a as [(t: unknown) => Promise<unknown>])),
  },
}));

const clearSessionCookie = vi.fn();
vi.mock("../auth/sessionCookie.js", () => ({
  clearSessionCookie: (...a: unknown[]) => clearSessionCookie(...a),
}));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
vi.mock("../utils/logger.js", () => ({
  log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const {
  registerOptions,
  registerVerify,
  loginOptions,
  loginVerify,
  listCredentials,
  deleteCredential,
} = await import(
  "./webauthn.controller.js",
);

const CALLER = { id: 42, id_sesion: "sesion-de-isaias" };

function respuestaFalsa() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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
  return res;
}

const peticion = (body: unknown = {}) => ({ user: CALLER, body, ip: "10.0.0.1" });

/** A verification that succeeded, shaped like the library's own return value. */
const VERIFICADA = {
  verified: true,
  registrationInfo: {
    credential: {
      id: "credencial-base64url",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal", "hybrid"],
    },
    credentialDeviceType: "multiDevice",
    credentialBackedUp: true,
    userVerified: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBAUTHN_RP_ID = "www.osefi.net";
  process.env.WEBAUTHN_ORIGIN = "https://www.osefi.net";

  usuarioFindByPk.mockResolvedValue({ dataValues: { id: 42, user: "isaias", name: "Isaias" } });
  credencialFindAll.mockResolvedValue([]);
  credencialCreate.mockResolvedValue({ dataValues: { id: 7 } });
  generateRegistrationOptions.mockResolvedValue({ challenge: "reto-fresco" });
  guardarReto.mockResolvedValue(undefined);
  purgarRetosCaducados.mockResolvedValue(0);
  consumirReto.mockResolvedValue({ id_usuario: 42, id_sesion: "sesion-de-isaias" });
  promoverSesion.mockResolvedValue(true);
  sellarPruebaDeFactor.mockResolvedValue(undefined);
  apagarLaMecha.mockResolvedValue(undefined);
  contarCodigosRestantes.mockResolvedValue(0);
  prepararCodigos.mockResolvedValue({ codigos: ["a", "b"], filas: [], ahora: new Date() });
  escribirCodigos.mockResolvedValue(undefined);
  logAction.mockResolvedValue(undefined);
  credencialFindOne.mockResolvedValue({ dataValues: { id: 7, nombre: "el movil de Isaias" } });
  credencialDestroy.mockResolvedValue(1);
  // Por defecto queda otra llave: revocar las sesiones de todo el mundo es lo
  // excepcional, y un test que lo quiera tiene que pedirlo.
  tieneAlgunFactor.mockResolvedValue(true);
  revokeAllSessionsOf.mockResolvedValue(3);
  revokeAllRememberedDevicesOf.mockResolvedValue(2);
  // The library calls `expectedChallenge` itself; the fake has to do the same
  // or the redemption never runs and half of these tests would pass against a
  // controller that never checks the challenge at all.
  verifyRegistrationResponse.mockImplementation(async (opts: Record<string, unknown>) => {
    const comprobar = opts.expectedChallenge as (c: string) => Promise<boolean>;
    if (typeof comprobar === "function") {
      const vale = await comprobar("reto-fresco");
      if (!vale) throw new Error("challenge rechazado");
    }
    return VERIFICADA;
  });

  // ── El camino de autenticación ──────────────────────────────────────────
  generateAuthenticationOptions.mockResolvedValue({ challenge: "reto-de-autenticacion" });
  buscarCredencialDe.mockResolvedValue({
    id: 7,
    credential_id: "credencial-base64url",
    public_key: Buffer.from([1, 2, 3]),
    // A string, because that is what `pg` hands back for a BIGINT. Writing a
    // number here would let a controller that forgets `Number(...)` pass.
    counter: "5",
  });
  marcarCredencialUsada.mockResolvedValue(undefined);
  verifyAuthenticationResponse.mockImplementation(async (opts: Record<string, unknown>) => {
    const comprobar = opts.expectedChallenge as (c: string) => Promise<boolean>;
    if (typeof comprobar === "function") {
      const vale = await comprobar("reto-de-autenticacion");
      if (!vale) throw new Error("challenge rechazado");
    }
    return { verified: true, authenticationInfo: { newCounter: 6 } };
  });
});

describe("registerOptions — what the browser is asked for", () => {
  // 🔴 Both of these are decided here, at registration, and cannot be changed
  // afterwards for a credential that already exists.
  it("demands a discoverable credential and a verified user", async () => {
    await registerOptions(peticion() as never, respuestaFalsa() as never);

    expect(generateRegistrationOptions.mock.calls[0][0]).toMatchObject({
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
  });

  // Omitted, the library mints a random id per call, and a browser reading two
  // different ids for one person stores two unrelated passkeys instead of
  // recognising the account it already has.
  it("identifies the account by its own id, not a fresh random one", async () => {
    await registerOptions(peticion() as never, respuestaFalsa() as never);

    const opts = generateRegistrationOptions.mock.calls[0][0] as { userID: Uint8Array };
    expect(new TextDecoder().decode(opts.userID)).toBe("42");
  });

  it("uses the configured relying party id, never a guess", async () => {
    await registerOptions(peticion() as never, respuestaFalsa() as never);

    expect(generateRegistrationOptions.mock.calls[0][0]).toMatchObject({
      rpID: "www.osefi.net",
    });
  });

  it("tells the authenticator which credentials this account already has", async () => {
    credencialFindAll.mockResolvedValue([
      { dataValues: { credential_id: "ya-registrada", transports: "internal,hybrid" } },
    ]);
    await registerOptions(peticion() as never, respuestaFalsa() as never);

    expect(generateRegistrationOptions.mock.calls[0][0]).toMatchObject({
      excludeCredentials: [{ id: "ya-registrada", transports: ["internal", "hybrid"] }],
    });
  });

  // 🔴 The challenge is what makes exactly one answer acceptable. Without this
  // write there is nothing for `registerVerify` to redeem, and the ceremony
  // fails at the far end with an error that names nothing.
  it("writes the challenge down against this session and this purpose", async () => {
    await registerOptions(peticion() as never, respuestaFalsa() as never);

    expect(guardarReto).toHaveBeenCalledWith("reto-fresco", "registro", {
      id_usuario: 42,
      id_sesion: "sesion-de-isaias",
    });
  });
});

describe("registerVerify — refusing before writing anything", () => {
  it("insists on a name, and never lets Postgres be the one to refuse", async () => {
    for (const nombre of ["", "   ", "x".repeat(101)]) {
      const res = respuestaFalsa();
      await registerVerify(peticion({ nombre, respuesta: {} }) as never, res as never);
      expect(res.statusCode).toBe(400);
      expect(credencialCreate).not.toHaveBeenCalled();
    }
  });

  it("redeems the challenge for this purpose and this session", async () => {
    await registerVerify(
      peticion({ nombre: "Mi móvil", respuesta: {} }) as never,
      respuestaFalsa() as never,
    );

    expect(consumirReto).toHaveBeenCalledWith("reto-fresco", "registro", {
      id_sesion: "sesion-de-isaias",
    });
  });

  // 🔴 The whole family of bugs where a ceremony started by one account is
  // finished against another. The session already constrains the redemption;
  // this is the second lock, and it costs one comparison.
  it("refuses when the challenge belonged to somebody else", async () => {
    consumirReto.mockResolvedValue({ id_usuario: 999, id_sesion: "sesion-de-isaias" });
    const res = respuestaFalsa();

    await registerVerify(peticion({ nombre: "Mi móvil", respuesta: {} }) as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(credencialCreate).not.toHaveBeenCalled();
  });

  it("refuses when the challenge cannot be redeemed at all", async () => {
    consumirReto.mockResolvedValue(null);
    const res = respuestaFalsa();

    await registerVerify(peticion({ nombre: "Mi móvil", respuesta: {} }) as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(credencialCreate).not.toHaveBeenCalled();
  });

  // 🔴 The setting that decides what `mfa_satisfied_at` means. With it off, an
  // assertion can come back meaning "this laptop was unlocked" — and that
  // stamp opens ten minutes of the permission matrix.
  it("requires the authenticator to have verified the user", async () => {
    await registerVerify(
      peticion({ nombre: "Mi móvil", respuesta: {} }) as never,
      respuestaFalsa() as never,
    );

    expect(verifyRegistrationResponse.mock.calls[0][0]).toMatchObject({
      requireUserVerification: true,
      expectedRPID: "www.osefi.net",
      expectedOrigin: ["https://www.osefi.net"],
    });
  });

  it("does not leak that another account already holds that credential", async () => {
    const choque = new Error("duplicate key");
    choque.name = "SequelizeUniqueConstraintError";
    credencialCreate.mockRejectedValue(choque);
    const res = respuestaFalsa();

    await registerVerify(peticion({ nombre: "Mi móvil", respuesta: {} }) as never, res as never);

    expect(res.statusCode).toBe(400);
    // The same sentence a duplicate of one's own credential gets. Saying "that
    // credential is already registered" would confirm to a caller that some
    // other account holds it.
    expect((res.body as { message: string }).message).not.toMatch(/registrada ya|otra cuenta/i);
  });
});

describe("registerVerify — the six writes, one test each", () => {
  const registrar = () =>
    registerVerify(
      peticion({ nombre: "Mi móvil", respuesta: {} }) as never,
      respuestaFalsa() as never,
    );

  it("1. stores the credential, with the counter as the string the column returns", async () => {
    await registrar();

    const fila = credencialCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(fila).toMatchObject({
      id_usuario: 42,
      credential_id: "credencial-base64url",
      transports: "internal,hybrid",
      nombre: "Mi móvil",
    });
    // 🔴 A string, not a number. The column is BIGINT and `pg` hands it back
    // as text; writing a number here would compile and then make every
    // comparison in `esContadorDeClon` meet two different types.
    expect(fila.counter).toBe("0");
    expect(credencialCreate.mock.calls[0][1]).toMatchObject({ transaction: TRANSACCION });
  });

  it("2. promotes the session, so an onboarding account stops being onboarding", async () => {
    await registrar();

    // Without this, `requireStepUp` refuses that session with
    // `estado-incompleto` — and the client's interceptor never retries that
    // reason. The only way out would be logging out and back in.
    expect(promoverSesion).toHaveBeenCalledWith("sesion-de-isaias", "passkey", {
      transaction: TRANSACCION,
    });
  });

  // 🔴 Finding F2/B-1, reproduced exactly. A `completa` session inside the
  // grace period registers a passkey; the promotion matches no row and returns
  // false; nobody stamps `mfa_satisfied_at`. From that instant
  // `tieneAlgunFactor` says true, so `requireStepUp`'s "nothing to prove"
  // branch stops applying, and no protected write works again in that session.
  it("3. seals the proof itself when there was nothing to promote", async () => {
    promoverSesion.mockResolvedValue(false);
    await registrar();

    expect(sellarPruebaDeFactor).toHaveBeenCalledWith("sesion-de-isaias", "passkey", {
      transaction: TRANSACCION,
    });
  });

  it("3b. and does not write the session twice when the promotion did work", async () => {
    promoverSesion.mockResolvedValue(true);
    await registrar();

    expect(sellarPruebaDeFactor).not.toHaveBeenCalled();
  });

  it("4. puts out the grace-period fuse", async () => {
    await registrar();

    expect(apagarLaMecha).toHaveBeenCalledWith(42, { transaction: TRANSACCION });
  });

  // 🔴 The one that gets forgotten, and for a passkey-only account it is the
  // difference between a lost phone and a lost account: the manual endpoint
  // that issues these sits behind a gate such an account cannot pass.
  it("5. issues ten recovery codes when the account has none", async () => {
    await registrar();

    expect(escribirCodigos).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ codigos: ["a", "b"] }),
      TRANSACCION,
    );
  });

  it("5b. and leaves an existing printed sheet alone", async () => {
    // Gated on outstanding codes, never on the factor count — regenerating
    // over a sheet somebody has printed would kill it while they hold it.
    contarCodigosRestantes.mockResolvedValue(3);
    await registrar();

    expect(prepararCodigos).not.toHaveBeenCalled();
    expect(escribirCodigos).not.toHaveBeenCalled();
  });

  // 🔴 Measured: ten bcrypt hashes at cost 12 are 2646 ms. Inside the
  // transaction they hold row locks on three tables and one of the pool's
  // fifteen connections while doing arithmetic that touches no database.
  it("5c. hashes the codes before opening the transaction, not inside it", async () => {
    const orden: string[] = [];
    prepararCodigos.mockImplementation(async () => {
      orden.push("hash");
      return { codigos: ["a"], filas: [], ahora: new Date() };
    });
    credencialCreate.mockImplementation(async () => {
      orden.push("primera-escritura");
      // The real row, not `{}`: the handler reads `dataValues.id` off it now,
      // and a bare object made this test pass over a 500 — the `orden`
      // assertion was already satisfied before the crash.
      return { dataValues: { id: 7 } };
    });

    await registrar();

    expect(orden).toEqual(["hash", "primera-escritura"]);
  });

  // 🔴 Load-bearing, not decorative: the table has no soft delete, so this is
  // the only record the credential ever existed — and an attacker who
  // registers their own passkey is invisible without it.
  it("6. writes the bitácora line for the registration", async () => {
    await registrar();

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: 42,
        action: "WEBAUTHN_REGISTERED",
        entity: "credencial_webauthn",
      }),
    );
  });

  // 🔴 So that this line and the `WEBAUTHN_DELETED` that may follow it can be
  // read as a pair. Without the id, the bitácora shows a key being removed and
  // the logins it opened, and nothing anywhere says when it was created.
  it("6d. names the row it created, and files it as critical like TOTP_CONFIRMED", async () => {
    await registrar();

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_REGISTERED",
        entity_id: 7,
        severity: "critical",
      }),
    );
  });

  it("6b. and a separate one for the codes, because they are a separate fact", async () => {
    await registrar();

    const acciones = logAction.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acciones).toContain("RECOVERY_CODES_ISSUED");
  });

  it("6c. but not that second line when no codes were minted", async () => {
    contarCodigosRestantes.mockResolvedValue(3);
    await registrar();

    const acciones = logAction.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acciones).toContain("WEBAUTHN_REGISTERED");
    expect(acciones).not.toContain("RECOVERY_CODES_ISSUED");
  });
});

describe("registerVerify — what comes back", () => {
  it("hands the codes over exactly once, in the response that minted them", async () => {
    const res = respuestaFalsa();
    await registerVerify(peticion({ nombre: "Mi móvil", respuesta: {} }) as never, res as never);

    expect(res.statusCode).toBe(201);
    // There is no endpoint that reads these back. If this response does not
    // carry them, they exist only as hashes and nobody can ever see them.
    expect((res.body as { codigosRecuperacion: string[] }).codigosRecuperacion).toEqual(["a", "b"]);
  });

  it("says so plainly when there were none to hand over", async () => {
    contarCodigosRestantes.mockResolvedValue(3);
    const res = respuestaFalsa();
    await registerVerify(peticion({ nombre: "Mi móvil", respuesta: {} }) as never, res as never);

    expect(res.statusCode).toBe(201);
    expect((res.body as { codigosRecuperacion: string[] | null }).codigosRecuperacion).toBeNull();
  });
});

describe("loginOptions — proving a passkey that already exists", () => {
  it("offers only this account's own credentials", async () => {
    credencialFindAll.mockResolvedValue([
      { dataValues: { credential_id: "cred-1", transports: "internal" } },
    ]);
    await loginOptions(peticion() as never, respuestaFalsa() as never);

    expect(generateAuthenticationOptions.mock.calls[0][0]).toMatchObject({
      allowCredentials: [{ id: "cred-1", transports: ["internal"] }],
      rpID: "www.osefi.net",
    });
  });

  // The same setting as at registration, and the same consequence: without it
  // an assertion can mean nothing more than "this device was unlocked", and
  // what it stamps opens ten minutes of the ERP's most sensitive writes.
  it("demands the authenticator verify the user", async () => {
    credencialFindAll.mockResolvedValue([{ dataValues: { credential_id: "c", transports: null } }]);
    await loginOptions(peticion() as never, respuestaFalsa() as never);

    expect(generateAuthenticationOptions.mock.calls[0][0]).toMatchObject({
      userVerification: "required",
    });
  });

  it("writes the challenge down for this ceremony and this session", async () => {
    credencialFindAll.mockResolvedValue([{ dataValues: { credential_id: "c", transports: null } }]);
    await loginOptions(peticion() as never, respuestaFalsa() as never);

    // 🔴 The purpose is what stops a challenge minted here being spent
    // completing a *registration*, and vice versa. It goes inside the same
    // `WHERE` that redeems it.
    expect(guardarReto).toHaveBeenCalledWith("reto-de-autenticacion", "segundo_factor", {
      id_usuario: 42,
      id_sesion: "sesion-de-isaias",
    });
  });

  it("says so plainly when the account has no passkey", async () => {
    credencialFindAll.mockResolvedValue([]);
    const res = respuestaFalsa();
    await loginOptions(peticion() as never, res as never);

    // Not an oracle: the caller is already authenticated as this account, so
    // it tells them only about themselves.
    expect(res.statusCode).toBe(400);
    expect(guardarReto).not.toHaveBeenCalled();
  });
});

describe("loginVerify — whose credential is this", () => {
  const probar = (body: unknown = { respuesta: { id: "credencial-base64url" } }) =>
    loginVerify(peticion(body) as never, respuestaFalsa() as never);

  // 🔴 The finding this endpoint exists to close. The full story is in
  // `buscarCredencialDe`: a colleague who knows your password otherwise
  // finishes your login with their own fingerprint, on a shared machine, with
  // an assertion that is cryptographically perfect.
  it("looks the credential up scoped to the session's own account", async () => {
    await probar();

    expect(buscarCredencialDe).toHaveBeenCalledWith("credencial-base64url", 42);
  });

  it("answers a credential that is not this account's exactly like one that does not exist", async () => {
    buscarCredencialDe.mockResolvedValue(null);
    const res = respuestaFalsa();
    await loginVerify(
      peticion({ respuesta: { id: "de-otra-persona" } }) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    // Telling the two apart would confirm to a caller that a credential they
    // hold is registered here under somebody else.
    expect((res.body as { message: string }).message).toBe(
      "No se pudo comprobar esa llave. Inténtalo otra vez.",
    );
    expect(promoverSesion).not.toHaveBeenCalled();
  });

  it("redeems the challenge for this ceremony and this session", async () => {
    await probar();

    expect(consumirReto).toHaveBeenCalledWith("reto-de-autenticacion", "segundo_factor", {
      id_sesion: "sesion-de-isaias",
    });
  });

  it("refuses when the challenge belonged to another account", async () => {
    consumirReto.mockResolvedValue({ id_usuario: 999, id_sesion: "sesion-de-isaias" });
    const res = respuestaFalsa();
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(promoverSesion).not.toHaveBeenCalled();
  });

  it("refuses a body with no assertion at all, before touching the database", async () => {
    const res = respuestaFalsa();
    await loginVerify(peticion({}) as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(buscarCredencialDe).not.toHaveBeenCalled();
  });
});

describe("loginVerify — the counter", () => {
  const probar = () =>
    loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

  // 🔴 The one place a BIGINT-as-string meets a library parameter typed
  // `number`. Hand the string through and the library's own comparison meets
  // two different types; `"5" <= 6` happens to coerce, but `counter > 0` on a
  // corrupt value does not, and nothing here would say so.
  it("hands the library a number, converted from the string the column returns", async () => {
    await probar();

    const opts = verifyAuthenticationResponse.mock.calls[0][0] as {
      credential: { counter: unknown };
    };
    expect(opts.credential.counter).toBe(5);
    expect(typeof opts.credential.counter).toBe("number");
  });

  it("records the credential as used, with the counter the assertion reported", async () => {
    await probar();

    expect(marcarCredencialUsada).toHaveBeenCalledWith(7, 6, { transaction: TRANSACCION });
  });

  // 🔴 A counter going backwards is the single signal that a credential has
  // been copied. The library would already have refused it — this branch is
  // what makes the event visible instead of vanishing into a generic 400.
  it("files a counter that went backwards as critical, and refuses", async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 3 },
    });
    const res = respuestaFalsa();
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_COUNTER_REGRESSION",
        severity: "critical",
      }),
    );
    expect(promoverSesion).not.toHaveBeenCalled();
  });

  // The credentials most people will actually use — iCloud Keychain, Google
  // Password Manager — report 0 on every assertion, forever. Refusing that is
  // the failure that bricks a passkey one use after registering it.
  it("accepts a synced passkey that always reports zero", async () => {
    buscarCredencialDe.mockResolvedValue({
      id: 7,
      credential_id: "credencial-base64url",
      public_key: Buffer.from([1, 2, 3]),
      counter: "0",
    });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    });
    const res = respuestaFalsa();
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(promoverSesion).toHaveBeenCalled();
  });
});

describe("loginVerify — turning the assertion into a proved factor", () => {
  const probar = () =>
    loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

  it("promotes a session that had not proved anything yet", async () => {
    await probar();

    expect(promoverSesion).toHaveBeenCalledWith("sesion-de-isaias", "passkey", {
      transaction: TRANSACCION,
    });
  });

  // The `completa` session refreshing its step-up window: the promotion
  // matches only `parcial` and `onboarding`, so without this nothing stamps
  // `mfa_satisfied_at` and the ten-minute window never opens — the caller
  // proves their factor and the gate keeps refusing them.
  it("seals the proof when there was nothing to promote", async () => {
    promoverSesion.mockResolvedValue(false);
    await probar();

    expect(sellarPruebaDeFactor).toHaveBeenCalledWith("sesion-de-isaias", "passkey", {
      transaction: TRANSACCION,
    });
  });

  it("does not write the session twice when the promotion worked", async () => {
    promoverSesion.mockResolvedValue(true);
    await probar();

    expect(sellarPruebaDeFactor).not.toHaveBeenCalled();
  });

  it("demands the authenticator verified the user, and checks origin and relying party", async () => {
    await probar();

    expect(verifyAuthenticationResponse.mock.calls[0][0]).toMatchObject({
      requireUserVerification: true,
      expectedRPID: "www.osefi.net",
      expectedOrigin: ["https://www.osefi.net"],
    });
  });
});

describe("loginVerify — the trail it leaves", () => {
  const probar = () =>
    loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

  const lineaDe = (accion: string) =>
    logAction.mock.calls
      .map((c) => c[0] as { action: string; metadata?: Record<string, unknown> })
      .find((l) => l.action === accion);

  // 🔴 A passkey was the one credential in the ERP that could finish a login
  // leaving nothing written down — and it is the one that syncs into somebody
  // else's Apple or Google account.
  it("files a finished login under the same name a TOTP login gets", async () => {
    promoverSesion.mockResolvedValue(true);
    await probar();

    expect(lineaDe("MFA_VERIFIED")).toBeDefined();
    expect(lineaDe("STEP_UP_REPROVED")).toBeUndefined();
  });

  // The other ceremony this same endpoint serves: a live `completa` session
  // re-opening its ten-minute window. Filed under what `/api/auth/stepup`
  // already writes, so a report counting re-accreditations does not miss a
  // whole method.
  it("files a refreshed step-up window under the step-up name", async () => {
    promoverSesion.mockResolvedValue(false);
    await probar();

    expect(lineaDe("STEP_UP_REPROVED")).toBeDefined();
    expect(lineaDe("MFA_VERIFIED")).toBeUndefined();
  });

  it("says the factor was a passkey, and which one", async () => {
    promoverSesion.mockResolvedValue(true);
    await probar();

    expect(lineaDe("MFA_VERIFIED")?.metadata).toMatchObject({
      fuente: "passkey",
      // Which key, of the several an account may hold: the question worth
      // asking after one is found to be copied is which sessions it opened.
      id_credencial: 7,
      id_sesion: "sesion-de-isaias",
    });
  });

  it("writes nothing when the assertion was refused", async () => {
    buscarCredencialDe.mockResolvedValue(null);
    await probar();

    expect(lineaDe("MFA_VERIFIED")).toBeUndefined();
    expect(lineaDe("STEP_UP_REPROVED")).toBeUndefined();
  });
});

describe("loginVerify — every refusal leaves a line", () => {
  const fallos = () =>
    logAction.mock.calls
      .map((c) => c[0] as { action: string; severity?: string; metadata?: Record<string, unknown> })
      .filter((l) => l.action === "WEBAUTHN_ASSERTION_FAILED");

  // 🔴 The other half of "a failed signature does not charge the lockout".
  // Without it these two routes have no charge, no rate limiter and no record,
  // and somebody with a stolen cookie can sit on them all night.
  it("records a signature the library refused", async () => {
    verifyAuthenticationResponse.mockResolvedValue({ verified: false });
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

    expect(fallos()).toHaveLength(1);
    expect(fallos()[0].metadata).toMatchObject({ motivo: "firma-invalida" });
  });

  it("records a spent or expired challenge, which the library throws for", async () => {
    verifyAuthenticationResponse.mockRejectedValue(new Error("challenge"));
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

    expect(fallos()[0]?.metadata).toMatchObject({ motivo: "verificacion-rechazada" });
  });

  // The response may not tell "no such credential" from "not yours". The
  // bitácora may, and must: one is a stale browser, the other is somebody
  // working through a list of credentials on a shared machine.
  it("records a credential that is not this account's", async () => {
    buscarCredencialDe.mockResolvedValue(null);
    await loginVerify(
      peticion({ respuesta: { id: "de-otra-persona" } }) as never,
      respuestaFalsa() as never,
    );

    expect(fallos()[0]?.metadata).toMatchObject({ motivo: "credencial-ajena-o-inexistente" });
  });

  // 🔴 The one refusal that writes **nothing**, and deliberately. No assertion
  // was offered, so there is nothing to say about a passkey — the same call
  // `mfa.controller.ts` makes for a missing code. It is also the cheapest
  // request an attacker can send, and the bitácora has no retention policy:
  // logging it would turn one stolen cookie into an unbounded INSERT.
  it("writes nothing for a body with no assertion in it", async () => {
    await loginVerify(peticion({}) as never, respuestaFalsa() as never);

    expect(fallos()).toHaveLength(0);
    expect(logAction).not.toHaveBeenCalled();
  });

  // Not `critical`: a cancelled system dialog lands here too, and a bitácora
  // where everything is critical is one nobody reads. The counter regression
  // keeps its own critical line — that one means a credential was copied.
  it("files them as warnings, not as incidents", async () => {
    verifyAuthenticationResponse.mockResolvedValue({ verified: false });
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

    expect(fallos()[0].severity).toBe("warning");
  });

  it("writes no failure line when the assertion is good", async () => {
    await loginVerify(
      peticion({ respuesta: { id: "credencial-base64url" } }) as never,
      respuestaFalsa() as never,
    );

    expect(fallos()).toHaveLength(0);
  });
});

describe("loginOptions — housekeeping", () => {
  // 🔴 Hanging the only purge off `registerOptions` left it running on the
  // rare ceremony and never on the frequent one: a passkey is registered once
  // in an account's life and proved on every login and every ten minutes of
  // step-up.
  it("purges expired challenges, the ceremony that actually repeats", async () => {
    credencialFindAll.mockResolvedValue([
      { dataValues: { credential_id: "cred-1", transports: null } },
    ]);
    await loginOptions(peticion() as never, respuestaFalsa() as never);

    expect(purgarRetosCaducados).toHaveBeenCalled();
  });

  it("still answers when the purge fails", async () => {
    credencialFindAll.mockResolvedValue([
      { dataValues: { credential_id: "cred-1", transports: null } },
    ]);
    purgarRetosCaducados.mockRejectedValue(new Error("la base de datos dijo que no"));
    const res = respuestaFalsa();
    await loginOptions(peticion() as never, res as never);

    // Tidying up must never cost somebody their login. Asserted on the body
    // and not on `statusCode`, which is 200 in this fake before the handler
    // runs — a handler that answered nothing at all would pass that.
    expect(res.body).toMatchObject({ challenge: "reto-de-autenticacion" });
  });
});


describe("listCredentials", () => {
  const peticionLista = () => ({ user: CALLER, body: {}, params: {}, ip: "10.0.0.1" });

  it("lists the keys of this account and of no other", async () => {
    credencialFindAll.mockResolvedValue([]);
    await listCredentials(peticionLista() as never, respuestaFalsa() as never);

    expect(credencialFindAll.mock.calls[0][0]).toMatchObject({ where: { id_usuario: 42 } });
  });

  // 🔴 The column list is the whole answer to "what leaves the process".
  // `public_key` is the one that must never go, and the model strips it twice
  // over — but this endpoint does not lean on either of those: it names what it
  // wants. `credential_id` is left out too. The browser sees it during a
  // ceremony because the authenticator needs it, but it is a stable, globally
  // unique handle for one key, and a list screen has no use for it.
  it("asks for the columns a screen needs, and for no others", async () => {
    credencialFindAll.mockResolvedValue([]);
    await listCredentials(peticionLista() as never, respuestaFalsa() as never);

    const atributos = (credencialFindAll.mock.calls[0][0] as { attributes: string[] }).attributes;
    expect(atributos).toEqual(["id", "nombre", "created_at", "last_used_at", "transports"]);
    expect(atributos).not.toContain("public_key");
    expect(atributos).not.toContain("credential_id");
    expect(atributos).not.toContain("counter");
  });

  // `nombre` has no per-user uniqueness — two keys called "mi movil" are
  // possible — so the dates are what make this list do its one job. Asserted on
  // the payload, because the `attributes` test above would still pass if the
  // handler then threw the dates away.
  it("hands back the dates that tell two keys of the same name apart", async () => {
    const creada = new Date("2026-08-01T10:00:00Z");
    credencialFindAll.mockResolvedValue([
      {
        dataValues: {
          id: 7,
          nombre: "mi movil",
          created_at: creada,
          last_used_at: null,
          transports: "internal",
        },
      },
    ]);
    const res = respuestaFalsa();
    await listCredentials(peticionLista() as never, res as never);

    expect(res.body).toEqual({
      credenciales: [
        { id: 7, nombre: "mi movil", created_at: creada, last_used_at: null, transports: "internal" },
      ],
    });
  });

  // Every other list this API answers is an object with a named field
  // (`{ sesiones }`, `{ codigos }`): a bare array cannot grow a sibling later
  // without breaking the client that consumes it.
  it("answers an object with a named field, never a bare array", async () => {
    credencialFindAll.mockResolvedValue([]);
    const res = respuestaFalsa();
    await listCredentials(peticionLista() as never, res as never);

    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).toHaveProperty("credenciales");
  });

  it("answers 401 without a session", async () => {
    const res = respuestaFalsa();
    await listCredentials({ user: undefined, body: {}, params: {} } as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(credencialFindAll).not.toHaveBeenCalled();
  });

  it("answers an empty list rather than an error when there are none", async () => {
    credencialFindAll.mockResolvedValue([]);
    const res = respuestaFalsa();
    await listCredentials(peticionLista() as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ credenciales: [] });
  });
});

describe("deleteCredential", () => {
  const peticionBorrado = (id = "7") => ({
    user: CALLER,
    body: {},
    params: { id },
    ip: "10.0.0.1",
  });

  // 🔴 The finding this route is written against. The id comes off the URL,
  // where anybody may put any number; the owner comes off the session. Both in
  // the same statement, so there is no window between checking and deleting.
  it("scopes the delete to the caller own account, in the same WHERE", async () => {
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(credencialDestroy.mock.calls[0][0]).toMatchObject({
      where: { id: 7, id_usuario: 42 },
    });
  });

  it("answers a key that is not this account's exactly like one that does not exist", async () => {
    credencialFindOne.mockResolvedValue(null);
    credencialDestroy.mockResolvedValue(0);
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado("999") as never, res as never);

    expect(res.statusCode).toBe(404);
    // Telling the two apart would make this a probe for which ids are
    // registered here.
    expect((res.body as { message: string }).message).toBe("Esa llave no existe.");
  });

  it("refuses a path segment that is not a positive integer, before any query", async () => {
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado("no-es-un-numero") as never, res as never);

    expect(res.statusCode).toBe(404);
    expect(credencialDestroy).not.toHaveBeenCalled();
    expect(credencialFindOne).not.toHaveBeenCalled();
  });

  it("leaves the rest of the account alone while another key remains", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado() as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect((res.body as { sesion_cerrada: boolean }).sesion_cerrada).toBe(false);
  });

  // 🔴 The one mutation nothing else can see. `tieneAlgunFactor` takes no
  // transaction, so a delete wrapped in one would have the count run on
  // another connection, find the row this request is removing, and never
  // revoke anything — and "make these three writes atomic" is exactly the
  // refactor somebody will propose. With an unobservable fake it lands green.
  it("runs outside any transaction, on purpose", async () => {
    tieneAlgunFactor.mockResolvedValue(false);
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(transaction).not.toHaveBeenCalled();
  });

  // 🔴 `estadoEfectivo` never walks back an `mfa_source` already written — it
  // returns on its first line for a row that says `completa`. So without this,
  // a cookie minted before the deletion goes on holding the whole ERP, with no
  // factor behind it, for up to `SESSION_ABSOLUTE_DAYS`. A remembered device
  // is the same key by another name.
  it("revokes every session and every remembered device when the last factor goes", async () => {
    tieneAlgunFactor.mockResolvedValue(false);
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado() as never, res as never);

    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(42);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(42);
    expect((res.body as { message: string }).message).toContain("se han cerrado todas tus sesiones");
    // The caller's own session is among the revoked: leaving the cookie means
    // a bare 401 on the next request instead of a clean return to the login.
    expect(clearSessionCookie).toHaveBeenCalled();
    // And the body says so in a field, so the client does not string-match
    // three sentences to learn its own session just ended.
    expect((res.body as { sesion_cerrada: boolean }).sesion_cerrada).toBe(true);
  });

  // 🔴 With N keys the question is not "did I have a factor" but "is there one
  // left", so it can only be asked after the row is gone. Asked before, an
  // account deleting its only key would always see one and never revoke.
  it("asks whether a factor is left only after the row is destroyed", async () => {
    const orden: string[] = [];
    credencialDestroy.mockImplementation(async () => {
      orden.push("destroy");
      return 1;
    });
    tieneAlgunFactor.mockImplementation(async () => {
      orden.push("count");
      return false;
    });
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(orden).toEqual(["destroy", "count"]);
  });

  const lineas = () => logAction.mock.calls.map((c) => (c[0] as { action: string }).action);
  const lineaDe = (accion: string) =>
    logAction.mock.calls
      .map((c) => c[0] as { action: string; severity?: string; metadata?: Record<string, unknown> })
      .find((l) => l.action === accion);

  // The table has no soft delete: after this, the bitacora is the only record
  // that the credential ever existed — so the line carries the name, which is
  // gone from the table the moment the row is.
  it("always writes WEBAUTHN_DELETED, naming the key", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(lineaDe("WEBAUTHN_DELETED")).toMatchObject({
      severity: "warning",
      metadata: expect.objectContaining({ nombre: "el movil de Isaias" }),
    });
    expect(lineaDe("LAST_FACTOR_REMOVED")).toBeUndefined();
  });

  // 🔴 Written BEFORE the count, because every `await` between the delete and
  // this line was a way to lose the only record that the key existed: a
  // dropped connection on the count would have answered 500 with the row gone
  // and nothing anywhere saying so.
  it("writes that line before asking whether a factor is left", async () => {
    const orden: string[] = [];
    logAction.mockImplementation(async (l: { action: string }) => {
      // One tick late on purpose. Without it a `void logAction(...)` — the
      // style `totp.controller.ts` uses, so a plausible "uniformisation" —
      // would still push first and this test would keep passing while the
      // property it names (the row is written before the count runs) is gone.
      await Promise.resolve();
      orden.push(l.action);
    });
    tieneAlgunFactor.mockImplementation(async () => {
      orden.push("count");
      return true;
    });
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(orden).toEqual(["WEBAUTHN_DELETED", "count"]);
  });

  it("files the loss of the last factor as its own critical line, with what was revoked", async () => {
    tieneAlgunFactor.mockResolvedValue(false);
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(lineaDe("LAST_FACTOR_REMOVED")).toMatchObject({
      severity: "critical",
      metadata: expect.objectContaining({
        factor: "passkey",
        id_credencial: 7,
        sesiones_revocadas: 3,
        dispositivos_revocados: 2,
        recuento_fallido: false,
      }),
    });
  });

  // 🔴 The row is already gone when the count runs. If the count throws and
  // the handler simply dies, the account is left with no factor and every
  // session alive — and the retry is a 404, so nobody ever comes back to fix
  // it. Failing closed costs a re-login for somebody who still had a key;
  // failing open is permanent.
  it("revokes anyway when it cannot tell whether a factor is left, and says why", async () => {
    tieneAlgunFactor.mockRejectedValue(new Error("la base de datos dijo que no"));
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado() as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(42);
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(42);
    // Its own verb: a count by `action` must not find this under "last
    // factor removed", because the account may well still hold two keys.
    expect(lineaDe("SESSIONS_REVOKED_PRECAUTION")?.metadata).toMatchObject({ recuento_fallido: true });
    expect(lineaDe("LAST_FACTOR_REMOVED")).toBeUndefined();
    // And the sentence does not claim it was the last one either.
    expect((res.body as { message: string }).message).toContain("por precaución");
    expect((res.body as { message: string }).message).not.toContain("último factor");
    expect((res.body as { sesion_cerrada: boolean }).sesion_cerrada).toBe(true);
  });

  // What makes two COUNTs throw is almost always transient, and the `destroy`
  // that just succeeded says the database was alive a millisecond ago. One
  // retry turns the blip into the right answer; the closed failure above is
  // the net, not the road.
  it("tries the count once more before treating it as unanswerable", async () => {
    tieneAlgunFactor
      .mockRejectedValueOnce(new Error("un parpadeo"))
      .mockResolvedValueOnce(true);
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado() as never, res as never);

    expect(tieneAlgunFactor).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
    expect((res.body as { message: string }).message).toBe("Llave eliminada.");
  });

  it("tells the person to log back in when it really was the last one", async () => {
    tieneAlgunFactor.mockResolvedValue(false);
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado() as never, res as never);

    expect((res.body as { message: string }).message).toContain("Vuelve a iniciar sesión");
  });

  // The one outcome that must not look like success. The key is gone, the
  // sessions are not, and the retry is a 404: the answer has to say what to
  // do instead, and `logout-all` is reachable from every state this route is.
  it("answers a failed revocation as a failure that says what to do, and files it critical", async () => {
    tieneAlgunFactor.mockResolvedValue(false);
    revokeAllSessionsOf.mockRejectedValue(new Error("la base de datos dijo que no"));
    const res = respuestaFalsa();
    await deleteCredential(peticionBorrado() as never, res as never);

    expect(res.statusCode).toBe(500);
    expect((res.body as { message: string }).message).toContain("panel de seguridad");
    // A machine-readable discriminator, the way every refusal of this API
    // carries one: the screen must not have to match a Spanish sentence to
    // tell this from an ordinary 500.
    expect((res.body as { code: string }).code).toBe("REVOCACION_FALLIDA");
    expect(lineaDe("LAST_FACTOR_REVOCATION_FAILED")?.severity).toBe("critical");
    // The devices were revoked before the sessions threw: the line says so,
    // because whoever reads it has to know which half is still waiting.
    expect(lineaDe("LAST_FACTOR_REVOCATION_FAILED")?.metadata).toMatchObject({
      dispositivos_revocados: 2,
    });
    expect(lineaDe("LAST_FACTOR_REMOVED")).toBeUndefined();
    expect(clearSessionCookie).not.toHaveBeenCalled();
    // And the existence record was already written — it does not depend on
    // anything after the delete.
    expect(lineas()).toContain("WEBAUTHN_DELETED");
  });

  it("writes nothing and revokes nothing when there was no such key", async () => {
    credencialFindOne.mockResolvedValue(null);
    credencialDestroy.mockResolvedValue(0);
    await deleteCredential(peticionBorrado() as never, respuestaFalsa() as never);

    expect(logAction).not.toHaveBeenCalled();
    expect(tieneAlgunFactor).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });
});

describe("registerVerify — the recovery-codes line", () => {
  const registrar = () =>
    registerVerify(
      peticion({ nombre: "Mi móvil", respuesta: {} }) as never,
      respuestaFalsa() as never,
    );

  // One verb, one shape: `confirmTotp` writes this same action with the
  // account as entity, the count in metadata and `critical`. A report that
  // filters by any of those would count the sheets issued on TOTP and miss
  // the ones issued on a first passkey.
  it("matches the shape its TOTP twin writes under the same name", async () => {
    await registrar();

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RECOVERY_CODES_ISSUED",
        entity: "Usuario",
        entity_id: 42,
        severity: "critical",
        metadata: expect.objectContaining({ cantidad: 2 }),
      }),
    );
  });
});
