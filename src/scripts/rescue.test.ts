// The console half of §8's "vía de escape" — see `rescue.ts`'s own header for
// why this file matters more than most: pre-audit finding H3 measured that
// the browser button is unreachable in exactly the failure mode it exists
// for, which makes this script the only recourse, not the backup one.
//
// `auth/rescueCore.ts` is mocked whole, the same reasoning
// `usuario.controller.test.ts` gives for the same module: what belongs here
// is which operation this script calls, with which id and which actor, and
// how it turns each typed result into something printed on a terminal — not
// what the core does with a transaction or a bitácora line, which is
// `rescueCore.test.ts`'s job.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const resolverCuentaDeRescate = vi.fn();
const restablecerSegundoFactor = vi.fn();
const desbloquearCuentaDeRescate = vi.fn();
const revocarSesionesDeRescate = vi.fn();
const establecerEmailDeRescate = vi.fn();
const limpiarEmailDeRescate = vi.fn();
vi.mock("../auth/rescueCore.js", () => ({
  resolverCuentaDeRescate: (...a: unknown[]) => resolverCuentaDeRescate(...a),
  restablecerSegundoFactor: (...a: unknown[]) => restablecerSegundoFactor(...a),
  desbloquearCuentaDeRescate: (...a: unknown[]) => desbloquearCuentaDeRescate(...a),
  revocarSesionesDeRescate: (...a: unknown[]) => revocarSesionesDeRescate(...a),
  establecerEmailDeRescate: (...a: unknown[]) => establecerEmailDeRescate(...a),
  limpiarEmailDeRescate: (...a: unknown[]) => limpiarEmailDeRescate(...a),
}));

const close = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { close: (...a: unknown[]) => close(...a) },
}));

const { main, parseArgs, run, USO } = await import("./rescue.js");

/**
 * A snapshot taken the instant the module above finished loading — before the
 * first `beforeEach` gets a chance to clear the very mocks this checks.
 *
 * This is the guard test the encargo calls out by name: under vitest,
 * `process.argv[1]` is the test runner's own entry point, never this file, so
 * `executedDirectly` inside `rescue.ts` must read `false` and a bare `import`
 * must not touch the database, send a notice, or run any rescue as a side
 * effect. If the guard were ever removed or its condition inverted, this
 * would be nonzero before a single test body has run.
 */
const llamadasAlImportar = {
  resolver: resolverCuentaDeRescate.mock.calls.length,
  resetMfa: restablecerSegundoFactor.mock.calls.length,
  desbloquear: desbloquearCuentaDeRescate.mock.calls.length,
  revocarSesiones: revocarSesionesDeRescate.mock.calls.length,
  setEmail: establecerEmailDeRescate.mock.calls.length,
  clearEmail: limpiarEmailDeRescate.mock.calls.length,
  close: close.mock.calls.length,
};

const CUENTA_VIVA = { ok: true, id: 42, user: "tecnico_ana" };

/** A `ResultadoRescate<T>`-shaped success, close enough for every `run*`. */
function exito<T>(datos: T) {
  return { ok: true, cuenta: { id: 42, user: "tecnico_ana" }, avisoEnviado: true, datos };
}

let logs: string[];
let errors: string[];

beforeEach(() => {
  vi.clearAllMocks();
  resolverCuentaDeRescate.mockResolvedValue(CUENTA_VIVA);
  restablecerSegundoFactor.mockResolvedValue(
    exito({
      factoresBorrados: { passkeys: 1, totp: 1, codigos: 0 },
      sesionesRevocadas: 2,
      dispositivosRevocados: 1,
      graceUntil: new Date("2027-01-11T00:00:00.000Z"),
    }),
  );
  desbloquearCuentaDeRescate.mockResolvedValue(exito({ desbloqueada: true }));
  revocarSesionesDeRescate.mockResolvedValue(exito({ sesionesRevocadas: 2, dispositivosRevocados: 1 }));
  establecerEmailDeRescate.mockResolvedValue(exito({}));
  limpiarEmailDeRescate.mockResolvedValue(exito({}));
  close.mockResolvedValue(undefined);

  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("the direct-execution guard", () => {
  it("importing this module does not run a rescue as a side effect", () => {
    expect(llamadasAlImportar).toEqual({
      resolver: 0,
      resetMfa: 0,
      desbloquear: 0,
      revocarSesiones: 0,
      setEmail: 0,
      clearEmail: 0,
      close: 0,
    });
  });
});

describe("parseArgs", () => {
  it("parses --user and a single operation, in either order", () => {
    expect(parseArgs(["--user", "tecnico_ana", "--reset-mfa"])).toEqual({
      user: "tecnico_ana",
      operacion: { tipo: "reset-mfa" },
    });
    expect(parseArgs(["--reset-mfa", "--user", "tecnico_ana"])).toEqual({
      user: "tecnico_ana",
      operacion: { tipo: "reset-mfa" },
    });
  });

  it("parses each of the five operations", () => {
    expect(parseArgs(["--user", "a", "--unlock"])).toMatchObject({ operacion: { tipo: "unlock" } });
    expect(parseArgs(["--user", "a", "--revoke-sessions"])).toMatchObject({
      operacion: { tipo: "revoke-sessions" },
    });
    expect(parseArgs(["--user", "a", "--clear-email"])).toMatchObject({
      operacion: { tipo: "clear-email" },
    });
    expect(parseArgs(["--user", "a", "--set-email", "nueva@osefi.net"])).toEqual({
      user: "a",
      operacion: { tipo: "set-email", email: "nueva@osefi.net" },
    });
  });

  it("trims the --set-email address", () => {
    const r = parseArgs(["--user", "a", "--set-email", "  nueva@osefi.net  "]);
    expect(r).toEqual({ user: "a", operacion: { tipo: "set-email", email: "nueva@osefi.net" } });
  });

  it("rejects a missing --user", () => {
    const r = parseArgs(["--reset-mfa"]);
    expect(r).toEqual({ error: expect.stringContaining("--user") });
  });

  it("rejects an invocation naming no operation at all", () => {
    const r = parseArgs(["--user", "a"]);
    expect(r).toEqual({ error: expect.stringContaining("falta indicar una operación") });
  });

  it("rejects --user with no value", () => {
    const r = parseArgs(["--user"]);
    expect(r).toEqual({ error: expect.stringContaining("--user") });
  });

  it("rejects --user followed immediately by another flag, instead of swallowing it as the name", () => {
    const r = parseArgs(["--user", "--reset-mfa"]);
    expect(r).toEqual({ error: expect.stringContaining("--user") });
  });

  it("rejects --set-email with no address", () => {
    const r = parseArgs(["--user", "a", "--set-email"]);
    expect(r).toEqual({ error: expect.stringContaining("--set-email") });
  });

  it("rejects an unrecognised argument", () => {
    const r = parseArgs(["--user", "a", "--reset-mfa", "--wat"]);
    expect(r).toEqual({ error: expect.stringContaining("--wat") });
  });

  it("rejects two unrelated operations at once, generically", () => {
    const r = parseArgs(["--user", "a", "--unlock", "--revoke-sessions"]);
    expect(r).toEqual({
      error: expect.stringContaining("solo se admite una operación por invocación"),
    });
  });

  // H4 — pre-audit's specific demand: this combination is not merely "two
  // operations", it is a documented account-takeover chain, and gets refused
  // with its own message rather than falling into the generic "pick one" case.
  it("H4: refuses --set-email combined with --reset-mfa, with a message naming the reason", () => {
    const r = parseArgs(["--user", "a", "--set-email", "x@osefi.net", "--reset-mfa"]);
    expect(r).toEqual({
      error: expect.stringMatching(/--set-email.*--reset-mfa|--reset-mfa.*--set-email/),
    });
    if ("error" in r) {
      expect(r.error).toContain("dos");
    }
  });

  it("still refuses --set-email plus --reset-mfa when three or more flags are present", () => {
    const r = parseArgs(["--user", "a", "--unlock", "--set-email", "x@osefi.net", "--reset-mfa"]);
    expect(r).toEqual({ error: expect.stringContaining("--set-email") });
  });

  it("does NOT refuse the same two operations run as two separate invocations", () => {
    // The pre-audit's own instruction (Isaias's decision): the combination is
    // still buildable, just never in one command. Two clean, single-operation
    // calls are the intended way to do it.
    const primero = parseArgs(["--user", "a", "--set-email", "x@osefi.net"]);
    const segundo = parseArgs(["--user", "a", "--reset-mfa"]);
    expect(primero).toEqual({ user: "a", operacion: { tipo: "set-email", email: "x@osefi.net" } });
    expect(segundo).toEqual({ user: "a", operacion: { tipo: "reset-mfa" } });
  });
});

describe("main — usage and resolution", () => {
  it("--help prints usage, exits 0, and touches nothing", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(USO);
    expect(resolverCuentaDeRescate).not.toHaveBeenCalled();
  });

  it("no arguments at all prints usage and exits nonzero", async () => {
    const code = await main([]);
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toContain("Uso:");
  });

  it("a parse error is printed and exits nonzero without resolving any account", async () => {
    const code = await main(["--reset-mfa"]);
    expect(code).not.toBe(0);
    expect(resolverCuentaDeRescate).not.toHaveBeenCalled();
  });

  it("an unknown username prints its own message and exits nonzero", async () => {
    resolverCuentaDeRescate.mockResolvedValue({ ok: false, motivo: "no-encontrada" });
    const code = await main(["--user", "nadie", "--reset-mfa"]);
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toContain("No existe ninguna cuenta");
    expect(restablecerSegundoFactor).not.toHaveBeenCalled();
  });

  // H7 / the encargo's second priority test: an archived account gets its own
  // sentence, never the "no existe" a real typo would get — the difference
  // between "check your spelling" and "go un-archive the account first".
  it('H7: an archived account says so verbatim, never "no encontrada"', async () => {
    resolverCuentaDeRescate.mockResolvedValue({ ok: false, motivo: "archivada", user: "ex_empleado" });
    const code = await main(["--user", "ex_empleado", "--reset-mfa"]);
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toContain("Esta cuenta está archivada, desarchívala primero.");
    expect(errors.join("\n")).not.toContain("No existe ninguna cuenta");
    expect(restablecerSegundoFactor).not.toHaveBeenCalled();
  });

  it("an ambiguous name prints the colliding ids and acts on nothing", async () => {
    resolverCuentaDeRescate.mockResolvedValue({ ok: false, motivo: "ambigua", ids: [7, 8] });
    const code = await main(["--user", "ana", "--reset-mfa"]);
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toContain("7");
    expect(errors.join("\n")).toContain("8");
    expect(restablecerSegundoFactor).not.toHaveBeenCalled();
  });

  it("prints the resolved account before acting on it", async () => {
    await main(["--user", "TECNICO_ANA", "--reset-mfa"]);
    expect(logs.join("\n")).toContain("@tecnico_ana (id 42)");
  });
});

describe("main — actor", () => {
  it("names the console, not a person, and carries no IP", async () => {
    await main(["--user", "a", "--reset-mfa"]);
    const [, actor] = restablecerSegundoFactor.mock.calls[0] as [number, { descripcion: string; ip: null }];
    expect(actor.descripcion).toMatch(/^consola: .+@.+ \(pid \d+\)$/);
    expect(actor.ip).toBeNull();
  });
});

describe("main — --reset-mfa", () => {
  it("calls restablecerSegundoFactor with the resolved id", async () => {
    await main(["--user", "a", "--reset-mfa"]);
    expect(restablecerSegundoFactor).toHaveBeenCalledWith(42, expect.anything());
  });

  it("reports the grace deadline and revocation counts, and exits 0", async () => {
    const code = await main(["--user", "a", "--reset-mfa"]);
    expect(code).toBe(0);
    const salida = logs.join("\n");
    expect(salida).toContain("2027-01-11T00:00:00.000Z");
    expect(salida).toContain("Sesiones cerradas: 2");
    expect(salida).toContain("Dispositivos recordados revocados: 1");
  });

  it("says what to tell the rescued person", async () => {
    await main(["--user", "a", "--reset-mfa"]);
    expect(logs.join("\n")).toMatch(/contarle/i);
  });

  it("prints when the security notice did not go out, without failing the operation", async () => {
    restablecerSegundoFactor.mockResolvedValue({
      ok: true,
      cuenta: { id: 42, user: "tecnico_ana" },
      avisoEnviado: false,
      datos: {
        factoresBorrados: { passkeys: 0, totp: 0, codigos: 0 },
        sesionesRevocadas: 0,
        dispositivosRevocados: 0,
        graceUntil: new Date("2027-01-11T00:00:00.000Z"),
      },
    });
    const code = await main(["--user", "a", "--reset-mfa"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Aviso NO enviado");
  });

  it("a race that archives the account between resolution and mutation is reported, not thrown", async () => {
    restablecerSegundoFactor.mockResolvedValue({ ok: false, motivo: "archivada", user: "tecnico_ana" });
    const code = await main(["--user", "a", "--reset-mfa"]);
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toContain("archivada");
  });
});

describe("main — --unlock", () => {
  it("calls desbloquearCuentaDeRescate and reports success", async () => {
    const code = await main(["--user", "a", "--unlock"]);
    expect(desbloquearCuentaDeRescate).toHaveBeenCalledWith(42, expect.anything());
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Bloqueo levantado");
  });

  it("says plainly when there was nothing to unlock", async () => {
    desbloquearCuentaDeRescate.mockResolvedValue(exito({ desbloqueada: false }));
    await main(["--user", "a", "--unlock"]);
    expect(logs.join("\n")).toContain("no tenía ningún bloqueo activo");
  });
});

describe("main — --revoke-sessions", () => {
  it("calls revocarSesionesDeRescate and reports both counts", async () => {
    const code = await main(["--user", "a", "--revoke-sessions"]);
    expect(revocarSesionesDeRescate).toHaveBeenCalledWith(42, expect.anything());
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Sesiones cerradas: 2");
    expect(logs.join("\n")).toContain("Dispositivos recordados revocados: 1");
  });
});

describe("main — --set-email", () => {
  it("calls establecerEmailDeRescate with the id and the typed address", async () => {
    await main(["--user", "a", "--set-email", "nueva@osefi.net"]);
    expect(establecerEmailDeRescate).toHaveBeenCalledWith(42, "nueva@osefi.net", expect.anything());
  });

  it("reports success and exits 0", async () => {
    const code = await main(["--user", "a", "--set-email", "nueva@osefi.net"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("nueva@osefi.net");
  });

  // H8, the encargo's explicit example of a failure that must not read as a
  // raw driver dump: the core already turns the constraint violation into a
  // typed `motivo: "email-en-uso"` — this checks the translation, not the
  // constraint itself (that belongs to `rescueCore.test.ts`).
  it("H8: translates 'email-en-uso' into one sentence, not a Postgres error, and exits nonzero", async () => {
    establecerEmailDeRescate.mockResolvedValue({ ok: false, motivo: "email-en-uso" });
    const code = await main(["--user", "a", "--set-email", "tomada@osefi.net"]);
    expect(code).not.toBe(0);
    const salida = errors.join("\n");
    expect(salida).toContain("ya está verificada en otra cuenta");
    expect(salida).not.toMatch(/SequelizeUniqueConstraintError|constraint|duplicate key/i);
  });
});

describe("main — --clear-email", () => {
  it("calls limpiarEmailDeRescate and reports success", async () => {
    const code = await main(["--user", "a", "--clear-email"]);
    expect(limpiarEmailDeRescate).toHaveBeenCalledWith(42, expect.anything());
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("borrada");
  });
});

describe("run — the container-facing wrapper", () => {
  const argvOriginal = [...process.argv];

  afterEach(() => {
    process.argv = argvOriginal;
  });

  it("closes the sequelize pool after a clean run", async () => {
    process.argv = [argvOriginal[0], argvOriginal[1], "--user", "a", "--unlock"];
    await run();
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it("closes the pool even when the operation throws, and exits nonzero instead of crashing", async () => {
    resolverCuentaDeRescate.mockRejectedValue(new Error("la base no responde"));
    process.argv = [argvOriginal[0], argvOriginal[1], "--user", "a", "--reset-mfa"];
    await run();
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("la base no responde");
  });
});
