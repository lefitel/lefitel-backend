// The shared spine both doors of §8's "vía de escape" stand on — see the
// module's own header for why one copy matters more here than anywhere else
// in this plan.
//
// Every model this file touches is mocked, the same reasoning
// `usuario.controller.test.ts` already gives for `sessionStore.js` and
// `rememberedDeviceStore.js`: what is under test is which query this module
// asks for, with which `where` and inside which transaction — not the SQL
// itself, which belongs to each store's own test file — and the real models
// call `UsuarioModel.hasMany` on import, which a plain mock object has no
// method for.
//
// `avisarRescate` (`securityNotice.js`) is mocked too, so these tests can pin
// *when* it is called relative to the mutation and the bitácora line without
// depending on `mailer.js`, `MAIL_SECURITY_TO`, or a real `UsuarioModel.findByPk`
// for the account name — that function's own behaviour is
// `securityNotice.test.ts`'s business.

import { describe, it, expect, vi, beforeEach } from "vitest";

const findOne = vi.fn();
const findAll = vi.fn();
const update = vi.fn();
const restore = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...a: unknown[]) => findOne(...a),
    findAll: (...a: unknown[]) => findAll(...a),
    update: (...a: unknown[]) => update(...a),
    restore: (...a: unknown[]) => restore(...a),
  },
}));

const destroyPasskeys = vi.fn();
vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: { destroy: (...a: unknown[]) => destroyPasskeys(...a) },
}));
const destroyTotp = vi.fn();
vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: { destroy: (...a: unknown[]) => destroyTotp(...a) },
}));
const destroyCodigos = vi.fn();
vi.mock("../models/codigoRecuperacion.model.js", () => ({
  CodigoRecuperacionModel: { destroy: (...a: unknown[]) => destroyCodigos(...a) },
}));
const updateTokens = vi.fn();
vi.mock("../models/tokenUsoUnico.model.js", () => ({
  TokenUsoUnicoModel: { update: (...a: unknown[]) => updateTokens(...a) },
}));
const crearBitacora = vi.fn();
vi.mock("../models/bitacora.model.js", () => ({
  BitacoraModel: { create: (...a: unknown[]) => crearBitacora(...a) },
}));

const revokeAllSessionsOf = vi.fn();
vi.mock("./sessionStore.js", () => ({
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));
const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("./rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...a: unknown[]) => revokeAllRememberedDevicesOf(...a),
}));

const avisarRescate = vi.fn();
vi.mock("./securityNotice.js", () => ({
  avisarRescate: (...a: unknown[]) => avisarRescate(...a),
}));

const transaction = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...a: unknown[]) => transaction(...a) },
}));

const {
  proximaGraciaDeRescate,
  resolverCuentaDeRescate,
  restablecerSegundoFactor,
  desbloquearCuentaDeRescate,
  revocarSesionesDeRescate,
  establecerEmailDeRescate,
  limpiarEmailDeRescate,
  desarchivarCuentaDeRescate,
} = await import("./rescueCore.js");
const { RESCUE_GRACE_HOURS } = await import("../config/security.js");

/** Stands in for the Sequelize transaction every mutation runs inside. */
const TRANSACCION = { id: "una-transaccion" };

const ACTOR_CONSOLA = { descripcion: "consola: isaias@VPS-osefi (pid 4821)", ip: null };
const ACTOR_ENDPOINT = { descripcion: "endpoint: @admin_isaias (id 1)", ip: "203.0.113.5" };

const OBJETIVO = 42;

/** A live (non-archived) account row, the shape `findOne` returns by default. */
function filaActiva(overrides: Record<string, unknown> = {}) {
  return { dataValues: { id: OBJETIVO, user: "tecnico_ana", deletedAt: null, ...overrides } };
}

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(filaActiva());
  findAll.mockResolvedValue([]);
  update.mockResolvedValue([1]);
  destroyPasskeys.mockResolvedValue(0);
  destroyTotp.mockResolvedValue(0);
  destroyCodigos.mockResolvedValue(0);
  updateTokens.mockResolvedValue([0]);
  restore.mockResolvedValue(undefined);
  crearBitacora.mockResolvedValue(undefined);
  revokeAllSessionsOf.mockResolvedValue(0);
  revokeAllRememberedDevicesOf.mockResolvedValue(0);
  // A default that always succeeds, so the one test that makes it fail cannot
  // leak a `mockResolvedValueOnce`'s absence into a later test — see the same
  // note in `usuario.controller.test.ts`.
  avisarRescate.mockResolvedValue({ enviado: true });
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
});

describe("proximaGraciaDeRescate — H1: la gracia nunca se acorta; A4: nunca inventa un reloj", () => {
  const AHORA = new Date("2027-01-10T00:00:00.000Z");
  const VEINTICUATRO_HORAS_MS = RESCUE_GRACE_HOURS * 60 * 60 * 1000;

  it("leaves an account that never had a clock without one", () => {
    // A4: NULL here does not mean "no deadline, so start one" — it means
    // the clock never started (nobody has logged in since the 4A deploy).
    // A rescue is not a login, so it must not be what starts it either.
    const resultado = proximaGraciaDeRescate(null, AHORA);
    expect(resultado).toBeNull();
  });

  it("still gives 24 hours to an account whose deadline already passed", () => {
    // Pre-existing test, renamed to match this task's naming convention —
    // its logic is untouched by A4, which only changes the NULL branch.
    const vencida = new Date(AHORA.getTime() - 60_000);
    const resultado = proximaGraciaDeRescate(vencida, AHORA);
    expect(resultado?.getTime()).toBe(AHORA.getTime() + VEINTICUATRO_HORAS_MS);
  });

  it("never shortens a deadline that is further away than 24 hours", () => {
    // Pre-existing test, renamed to match this task's naming convention.
    // The rule that breaks a naive assignment: somebody with twelve days of
    // grace left must NOT have a rescue cut that down to one.
    const actual = new Date(AHORA.getTime() + 12 * 24 * 60 * 60 * 1000);
    const resultado = proximaGraciaDeRescate(actual, AHORA);
    expect(resultado).toEqual(actual);
  });

  it("never returns an instant earlier than the fresh 24 hours, for any non-null previous deadline", () => {
    // The "red if the rule breaks" form for every *non-null* input: this
    // assertion turns red if `proximaGraciaDeRescate` is ever rewritten as a
    // bare assignment (`return candidata`) instead of a maximum. `null` is
    // deliberately not in this list — for `null` the correct answer is
    // `null` itself, not a floor of 24 hours, and that is what the first
    // test above already pins down.
    for (const actual of [new Date(0), new Date(AHORA.getTime() - 1), new Date(AHORA.getTime() + 1)]) {
      const resultado = proximaGraciaDeRescate(actual, AHORA);
      expect(resultado?.getTime()).toBeGreaterThanOrEqual(AHORA.getTime() + VEINTICUATRO_HORAS_MS);
    }
  });
});

describe("resolverCuentaDeRescate — H7: las tres trampas de --user", () => {
  it("answers no-encontrada when nothing matches", async () => {
    findAll.mockResolvedValue([]);
    const r = await resolverCuentaDeRescate("nadie");
    expect(r).toEqual({ ok: false, motivo: "no-encontrada" });
  });

  it("resolves a single live match", async () => {
    findAll.mockResolvedValue([{ dataValues: { id: 7, user: "Omar Mita", deletedAt: null } }]);
    const r = await resolverCuentaDeRescate("omar mita");
    expect(r).toEqual({ ok: true, id: 7, user: "Omar Mita" });
  });

  it("refuses an archived account with its own reason, not 'no existe' — but still carries its id", async () => {
    // The id travels with the refusal because `--unarchive` (`rescue.ts`'s
    // own `main()`) is the one caller that needs to act on the account
    // despite this exact refusal instead of stopping at it.
    findAll.mockResolvedValue([{ dataValues: { id: 7, user: "ex_empleado", deletedAt: new Date() } }]);
    const r = await resolverCuentaDeRescate("ex_empleado");
    expect(r).toEqual({ ok: false, motivo: "archivada", user: "ex_empleado", id: 7 });
  });

  it("refuses as ambiguous when a live and an archived row share the case-folded name", async () => {
    findAll.mockResolvedValue([
      { dataValues: { id: 7, user: "ana", deletedAt: null } },
      { dataValues: { id: 8, user: "ANA", deletedAt: new Date() } },
    ]);
    const r = await resolverCuentaDeRescate("ana");
    expect(r).toEqual({ ok: false, motivo: "ambigua", ids: [7, 8] });
  });

  it("queries case-insensitively and including archived rows", async () => {
    await resolverCuentaDeRescate("Omar");
    const [args] = findAll.mock.calls[0] as [{ paranoid?: boolean }];
    expect(args.paranoid).toBe(false);
  });
});

describe("restablecerSegundoFactor — H1, H2, H6, H6-bis", () => {
  it("deletes every factor row for the target account", async () => {
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(destroyPasskeys).toHaveBeenCalledWith({ where: { id_usuario: OBJETIVO }, transaction: TRANSACCION });
    expect(destroyTotp).toHaveBeenCalledWith({ where: { id_usuario: OBJETIVO }, transaction: TRANSACCION });
    expect(destroyCodigos).toHaveBeenCalledWith({ where: { id_usuario: OBJETIVO }, transaction: TRANSACCION });
  });

  it("H6-bis: revokes sessions and remembered devices together, inside the same transaction", async () => {
    // La regla exacta que el hallazgo describe: revocar sesiones sin revocar
    // dispositivos deja viva la cookie que se salta el segundo factor entero.
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(OBJETIVO, { transaction: TRANSACCION });
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(OBJETIVO, { transaction: TRANSACCION });
  });

  it("H2: lifts the account lockout in the same write as the reset", async () => {
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    const escrituras = update.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const escrituraDeCuenta = escrituras.find((e) => "failed_attempts" in e);
    expect(escrituraDeCuenta).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  it("H1: extends the grace deadline using the account's own previous value — never a bare assignment", async () => {
    const lejos = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    // The account row `findOne` returns *inside the transaction*, for the
    // grace read — a second `findOne` call, after the one that resolves the
    // target in the shared preamble.
    findOne
      .mockResolvedValueOnce(filaActiva())
      .mockResolvedValueOnce({ dataValues: { mfa_grace_until: lejos } });

    const resultado = await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);

    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.datos.graceUntil).toEqual(lejos);
    const escrituras = update.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const escrituraDeCuenta = escrituras.find((e) => "mfa_grace_until" in e);
    expect(escrituraDeCuenta?.mfa_grace_until).toEqual(lejos);
  });

  it("A4: does not write mfa_grace_until at all for an account whose clock never started", async () => {
    // The trap this closes: writing `NULL` and not naming the column give
    // the same result on a row that already had NULL — which is exactly
    // why a shallow fix (writing `mfa_grace_until: null`) would pass a test
    // that only checked the resulting value. This checks the UPDATE's own
    // shape instead: the key must be absent, not merely falsy.
    findOne
      .mockResolvedValueOnce(filaActiva())
      .mockResolvedValueOnce({ dataValues: { mfa_grace_until: null } });

    const resultado = await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);

    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.datos.graceUntil).toBeNull();
    const escrituras = update.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const escrituraDeCuenta = escrituras.find((e) => "failed_attempts" in e);
    expect(escrituraDeCuenta).not.toHaveProperty("mfa_grace_until");
  });

  it("runs every mutation inside one transaction", async () => {
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("sends the security notice before touching anything, and confirms the bitácora line after", async () => {
    const orden: string[] = [];
    avisarRescate.mockImplementation(async () => {
      orden.push("aviso");
      return { enviado: true };
    });
    destroyPasskeys.mockImplementation(async () => {
      orden.push("mutacion");
      return 0;
    });
    crearBitacora.mockImplementation(async () => {
      orden.push("bitacora");
    });

    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);

    expect(orden).toEqual(["aviso", "mutacion", "bitacora"]);
  });

  it("writes the bitácora line outside the mutation transaction — no transaction in its own write", async () => {
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    const [, opciones] = crearBitacora.mock.calls[0] as [unknown, unknown];
    expect(opciones).toBeUndefined();
    expect(crearBitacora.mock.calls[0][0]).not.toHaveProperty("transaction");
  });

  it("attributes the bitácora line to the rescued account, with the real actor in metadata", async () => {
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: OBJETIVO,
        entity_id: OBJETIVO,
        action: "RESCUE_MFA_RESET",
        severity: "critical",
        metadata: expect.objectContaining({ actor: ACTOR_CONSOLA.descripcion, resultado: "ok" }),
      }),
    );
  });

  it("still writes the bitácora line — with resultado 'error' — when the mutation fails, and rethrows", async () => {
    // El matiz de H6: un rollback no debe borrar el único registro de que la
    // operación se intentó. Esta es la mitad que no se ve desde fuera: la
    // línea sobrevive aunque la transacción no llegue a nada.
    destroyPasskeys.mockRejectedValue(new Error("conexión perdida"));

    await expect(restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA)).rejects.toThrow("conexión perdida");

    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RESCUE_MFA_RESET",
        metadata: expect.objectContaining({ resultado: "error" }),
      }),
    );
  });

  it("sends the notice exactly once even when the mutation later fails", async () => {
    destroyPasskeys.mockRejectedValue(new Error("boom"));
    await expect(restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA)).rejects.toThrow();
    expect(avisarRescate).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-existent account without sending a notice or touching anything", async () => {
    findOne.mockResolvedValue(null);
    const resultado = await restablecerSegundoFactor(999, ACTOR_CONSOLA);
    expect(resultado).toEqual({ ok: false, motivo: "no-encontrada" });
    expect(avisarRescate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(crearBitacora).not.toHaveBeenCalled();
  });

  it("refuses an archived account, naming it, without sending a notice or touching anything", async () => {
    findOne.mockResolvedValue(filaActiva({ deletedAt: new Date() }));
    const resultado = await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado).toEqual({ ok: false, motivo: "archivada", user: "tecnico_ana" });
    expect(avisarRescate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reports the notice outcome back to the caller", async () => {
    avisarRescate.mockResolvedValue({ enviado: false });
    const resultado = await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.avisoEnviado).toBe(false);
  });
});

describe("desbloquearCuentaDeRescate", () => {
  it("clears failed_attempts and locked_until, and nothing about factors or sessions", async () => {
    await desbloquearCuentaDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(update).toHaveBeenCalledWith(
      { failed_attempts: 0, locked_until: null },
      { where: { id: OBJETIVO }, transaction: TRANSACCION },
    );
    expect(destroyPasskeys).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });

  it("sends its own notice and writes its own bitácora action", async () => {
    await desbloquearCuentaDeRescate(OBJETIVO, ACTOR_ENDPOINT);
    expect(avisarRescate).toHaveBeenCalledWith(
      expect.objectContaining({ operacion: "RESCUE_ACCOUNT_UNLOCK", id_usuario: OBJETIVO }),
    );
    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RESCUE_ACCOUNT_UNLOCK" }),
    );
  });
});

describe("revocarSesionesDeRescate — H6-bis: nunca sesiones sin dispositivos", () => {
  it("always revokes both together — there is no session-only path", async () => {
    await revocarSesionesDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(OBJETIVO, { transaction: TRANSACCION });
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(OBJETIVO, { transaction: TRANSACCION });
  });

  it("reports how many of each it revoked", async () => {
    revokeAllSessionsOf.mockResolvedValue(3);
    revokeAllRememberedDevicesOf.mockResolvedValue(2);
    const resultado = await revocarSesionesDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.datos.sesionesRevocadas).toBe(3);
      expect(resultado.datos.dispositivosRevocados).toBe(2);
    }
  });
});

describe("establecerEmailDeRescate — H4, H8", () => {
  it("normalises the address, sets it verified, and invalidates pending tokens in the same transaction", async () => {
    await establecerEmailDeRescate(OBJETIVO, "  Nueva@Osefi.NET  ", ACTOR_CONSOLA);
    expect(update).toHaveBeenCalledWith(
      { email: "nueva@osefi.net", email_verified_at: expect.any(Date) },
      { where: { id: OBJETIVO }, transaction: TRANSACCION },
    );
    expect(updateTokens).toHaveBeenCalledWith(
      { used_at: expect.any(Date) },
      { where: { id_usuario: OBJETIVO, used_at: null }, transaction: TRANSACCION },
    );
  });

  it("H8: turns the partial unique index's conflict into a typed refusal, not a raw 500", async () => {
    update.mockRejectedValue({
      name: "SequelizeUniqueConstraintError",
      parent: { constraint: "usuarios_email_verificado_uniq" },
      message: "duplicate key value violates unique constraint",
    });

    const resultado = await establecerEmailDeRescate(OBJETIVO, "tomada@osefi.net", ACTOR_CONSOLA);

    expect(resultado).toEqual({ ok: false, motivo: "email-en-uso" });
    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ resultado: "conflicto" }) }),
    );
  });

  it("still sends the notice before discovering the conflict — H4's mandatory trace", async () => {
    update.mockRejectedValue({
      name: "SequelizeUniqueConstraintError",
      parent: { constraint: "usuarios_email_verificado_uniq" },
    });
    await establecerEmailDeRescate(OBJETIVO, "tomada@osefi.net", ACTOR_CONSOLA);
    expect(avisarRescate).toHaveBeenCalledTimes(1);
  });

  it("propagates any other database failure instead of mistaking it for a conflict", async () => {
    update.mockRejectedValue(new Error("la base no responde"));
    await expect(establecerEmailDeRescate(OBJETIVO, "x@osefi.net", ACTOR_CONSOLA)).rejects.toThrow(
      "la base no responde",
    );
  });

  it("masks the address in the notice and the bitácora detail, never spelling it out", async () => {
    await establecerEmailDeRescate(OBJETIVO, "secreta@osefi.net", ACTOR_CONSOLA);
    const [avisoInput] = avisarRescate.mock.calls[0] as [{ detalle: string }];
    expect(avisoInput.detalle).not.toContain("secreta@osefi.net");
    expect(avisoInput.detalle).toContain("s***@osefi.net");
  });
});

describe("limpiarEmailDeRescate", () => {
  it("clears both the address and its verification stamp together", async () => {
    await limpiarEmailDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(update).toHaveBeenCalledWith(
      { email: null, email_verified_at: null },
      { where: { id: OBJETIVO }, transaction: TRANSACCION },
    );
  });

  it("invalidates pending tokens in the same transaction as the clear", async () => {
    await limpiarEmailDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(updateTokens).toHaveBeenCalledWith(
      { used_at: expect.any(Date) },
      { where: { id_usuario: OBJETIVO, used_at: null }, transaction: TRANSACCION },
    );
  });
});

describe("desarchivarCuentaDeRescate — A1: the one door Task 1 leaves open", () => {
  const CUENTA_ARCHIVADA = () => ({
    dataValues: { id: OBJETIVO, user: "tecnico_ana", deletedAt: new Date("2026-08-01T00:00:00.000Z") },
  });

  it("clears deletedAt on an archived account", async () => {
    findOne.mockResolvedValue(CUENTA_ARCHIVADA());
    const resultado = await desarchivarCuentaDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado.ok).toBe(true);
    expect(restore).toHaveBeenCalledWith({ where: { id: OBJETIVO }, transaction: TRANSACCION });
    if (resultado.ok) expect(resultado.datos).toEqual({ desarchivada: true });
  });

  it("refuses an account that is not archived, and says so", async () => {
    // The trap the encargo names by hand: copying one of the other four
    // operations here would drag in `cuentaActivaOrNull`'s refusal of an
    // archived account, and this order would never work. The live-account
    // fixture below is the case that must now be refused instead.
    findOne.mockResolvedValue(filaActiva());
    const resultado = await desarchivarCuentaDeRescate(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado).toEqual({ ok: false, motivo: "no-archivada", user: "tecnico_ana" });
    expect(restore).not.toHaveBeenCalled();
    expect(avisarRescate).not.toHaveBeenCalled();
  });

  it("refuses a non-existent account without sending a notice or touching anything", async () => {
    findOne.mockResolvedValue(null);
    const resultado = await desarchivarCuentaDeRescate(999, ACTOR_CONSOLA);
    expect(resultado).toEqual({ ok: false, motivo: "no-encontrada" });
    expect(avisarRescate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("sends the security notice before restoring, and confirms the bitácora line after", async () => {
    findOne.mockResolvedValue(CUENTA_ARCHIVADA());
    const orden: string[] = [];
    avisarRescate.mockImplementation(async () => {
      orden.push("aviso");
      return { enviado: true };
    });
    restore.mockImplementation(async () => {
      orden.push("restore");
    });
    crearBitacora.mockImplementation(async () => {
      orden.push("bitacora");
    });

    await desarchivarCuentaDeRescate(OBJETIVO, ACTOR_CONSOLA);

    expect(orden).toEqual(["aviso", "restore", "bitacora"]);
  });

  it("writes the bitácora line before answering ok", async () => {
    // The one that matters most: the audit line is the only thing that
    // survives a rescue, and this operation must confirm it before telling
    // its caller the account is back.
    findOne.mockResolvedValue(CUENTA_ARCHIVADA());
    let bitacoraEscritaAntesDeResolver = false;
    crearBitacora.mockImplementation(async () => {
      bitacoraEscritaAntesDeResolver = true;
    });

    const resultado = await desarchivarCuentaDeRescate(OBJETIVO, ACTOR_CONSOLA);

    expect(bitacoraEscritaAntesDeResolver).toBe(true);
    expect(resultado.ok).toBe(true);
    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: OBJETIVO,
        action: "RESCUE_ACCOUNT_UNARCHIVED",
        severity: "critical",
        metadata: expect.objectContaining({ actor: ACTOR_CONSOLA.descripcion, resultado: "ok" }),
      }),
    );
  });

  it("still writes the bitácora line — with resultado 'error' — when restoring fails, and rethrows", async () => {
    findOne.mockResolvedValue(CUENTA_ARCHIVADA());
    restore.mockRejectedValue(new Error("conexión perdida"));

    await expect(desarchivarCuentaDeRescate(OBJETIVO, ACTOR_CONSOLA)).rejects.toThrow("conexión perdida");

    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RESCUE_ACCOUNT_UNARCHIVED",
        metadata: expect.objectContaining({ resultado: "error" }),
      }),
    );
  });

  it("attributes the bitácora line to the rescued account, with the real actor in metadata", async () => {
    findOne.mockResolvedValue(CUENTA_ARCHIVADA());
    await desarchivarCuentaDeRescate(OBJETIVO, ACTOR_ENDPOINT);
    expect(crearBitacora).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: OBJETIVO,
        entity_id: OBJETIVO,
        metadata: expect.objectContaining({ actor: ACTOR_ENDPOINT.descripcion }),
      }),
    );
  });
});

// Plan 4E: the reset deletes credentials and leaves the verified address,
// which is a factor on its own — so the caller has to be told whether one is
// there, or it will tell the person "ya puede entrar solo con su contraseña"
// to somebody whose next login asks for a code by email.
describe("restablecerSegundoFactor — reports whether the verified email remains (plan 4E)", () => {
  it("says the address is a factor when it is verified, reading it beside the deadline", async () => {
    findOne
      .mockResolvedValueOnce(filaActiva())
      .mockResolvedValueOnce({ dataValues: { mfa_grace_until: null, email_verified_at: new Date("2026-09-01T00:00:00Z") } });
    const resultado = await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.datos.correoVerificado).toBe(true);
    const lectura = findOne.mock.calls[1][0] as { attributes?: string[] };
    expect(lectura.attributes).toContain("email_verified_at");
  });

  it("says it is not when the address is unverified or absent", async () => {
    findOne
      .mockResolvedValueOnce(filaActiva())
      .mockResolvedValueOnce({ dataValues: { mfa_grace_until: null, email_verified_at: null } });
    const resultado = await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.datos.correoVerificado).toBe(false);
  });

  it("does not touch the address: the reset is about devices, and the mailbox is the recovery channel", async () => {
    findOne
      .mockResolvedValueOnce(filaActiva())
      .mockResolvedValueOnce({ dataValues: { mfa_grace_until: null, email_verified_at: new Date() } });
    await restablecerSegundoFactor(OBJETIVO, ACTOR_CONSOLA);
    const escrituras = update.mock.calls.map((c) => c[0] as Record<string, unknown>);
    for (const e of escrituras) {
      expect(e).not.toHaveProperty("email");
      expect(e).not.toHaveProperty("email_verified_at");
    }
  });
});
