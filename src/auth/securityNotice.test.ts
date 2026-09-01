import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { CorreoAEnviar } from "./mailer.js";

// The mock carries the real signature. Declared with no parameters, as it was,
// vitest types every recorded call as an empty tuple, so `mock.calls[0][0]` —
// which four assertions below read — does not typecheck at all.
const enviarCorreo = vi.fn(async (_correo: CorreoAEnviar) => ({ ok: true }));
vi.mock("./mailer.js", () => ({ enviarCorreo: (correo: CorreoAEnviar) => enviarCorreo(correo) }));

const findByPk = vi.fn(async () => ({ dataValues: { user: "Diego" } }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: { findByPk: (...a: unknown[]) => findByPk(...(a as [])) } }));

const warn = vi.fn();
const error = vi.fn();
vi.mock("../utils/logger.js", () => ({ log: () => ({ warn, error, info: vi.fn() }) }));

const { avisarPasswordRestablecida, avisarCorreoCambiado, avisarRescate, maskEmail } =
  await import("./securityNotice.js");

beforeEach(() => {
  enviarCorreo.mockClear();
  warn.mockClear();
  error.mockClear();
  findByPk.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("maskEmail", () => {
  it("keeps the first letter and the whole domain, and nothing else", () => {
    expect(maskEmail("isaias@osefi.net")).toBe("i***@osefi.net");
  });

  /**
   * The three shapes a hand-written masking function gets wrong, and the
   * reason this has its own test at all: each one either throws or leaks the
   * whole address, and both happen inside an email nobody reads until
   * something has already gone wrong.
   */
  it("refuses to guess at anything that is not an address", () => {
    expect(maskEmail("sin-arroba")).toBe("***");
    expect(maskEmail("@empieza-por-arroba.com")).toBe("***");
    expect(maskEmail("acaba-en-arroba@")).toBe("***");
  });

  it("masks a one-letter local part without revealing it twice", () => {
    // `a@x.com` — the first letter *is* the whole local part, so the mask
    // cannot hide it. What it must not do is throw or return the input.
    expect(maskEmail("a@x.com")).toBe("a***@x.com");
  });
});

describe("avisarPasswordRestablecida", () => {
  it("tells the user even when MAIL_SECURITY_TO is not configured", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "");
    await avisarPasswordRestablecida({ id_usuario: 14, email_destino: "diego@osefi.net", ip: "1.2.3.4" });

    expect(enviarCorreo).toHaveBeenCalledTimes(1);
    expect(enviarCorreo.mock.calls[0][0]).toMatchObject({ para: "diego@osefi.net" });
  });

  /**
   * The variable is deliberately **not** in `requiredEnv` — a deployment
   * without it has to keep working. What it must not do is fail silently: a
   * deployment that never had this set looks exactly like one where the
   * notices work, right up until somebody goes looking for the warning that
   * was never sent.
   */
  it("says out loud that it skipped the copy, rather than skipping it quietly", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "");
    await avisarPasswordRestablecida({ id_usuario: 14, email_destino: "diego@osefi.net", ip: null });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toMatch(/MAIL_SECURITY_TO/);
  });

  it("sends the company copy too when it is configured, naming the account", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    await avisarPasswordRestablecida({ id_usuario: 14, email_destino: "diego@osefi.net", ip: "1.2.3.4" });

    expect(enviarCorreo).toHaveBeenCalledTimes(2);
    const copia = enviarCorreo.mock.calls[1][0] as { para: string; asunto: string; texto: string };
    expect(copia.para).toBe("seguridad@osefi.net");
    expect(copia.asunto).toContain("@Diego");
    // The IP is what makes the warning actionable: without it there is
    // nothing to investigate, only something to worry about.
    expect(copia.texto).toContain("1.2.3.4");
  });

  it("never puts the recovery address in the copy unmasked", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    await avisarPasswordRestablecida({ id_usuario: 14, email_destino: "diego@osefi.net", ip: null });
    const copia = enviarCorreo.mock.calls[1][0] as { texto: string; html: string };
    expect(copia.texto).not.toContain("diego@osefi.net");
    expect(copia.html).not.toContain("diego@osefi.net");
    expect(copia.texto).toContain("d***@osefi.net");
  });

  it("still names the account when the lookup fails, instead of throwing", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    findByPk.mockRejectedValueOnce(new Error("db down"));
    await avisarPasswordRestablecida({ id_usuario: 14, email_destino: "d@x.com", ip: null });
    expect(enviarCorreo.mock.calls[1][0]).toMatchObject({ asunto: expect.stringContaining("#14") });
  });
});

describe("avisarCorreoCambiado", () => {
  it("sends only the company copy — the user's warning goes to the previous address elsewhere", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    await avisarCorreoCambiado({
      id_usuario: 14, email_anterior: "viejo@osefi.net", email_nuevo: "nuevo@atacante.com", ip: "9.9.9.9",
    });
    expect(enviarCorreo).toHaveBeenCalledTimes(1);
    const copia = enviarCorreo.mock.calls[0][0] as { para: string; texto: string };
    expect(copia.para).toBe("seguridad@osefi.net");
    expect(copia.texto).toContain("v***@osefi.net");
    expect(copia.texto).toContain("n***@atacante.com");
  });

  it("does not send at all when MAIL_SECURITY_TO is missing, and says so", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "");
    await avisarCorreoCambiado({ id_usuario: 14, email_anterior: "a@x.com", email_nuevo: "b@y.com", ip: null });
    expect(enviarCorreo).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});

/**
 * §8's mandatory notice, shared by every rescue operation in
 * `auth/rescueCore.ts`. Decided by Isaias: this goes out whether the
 * request is legitimate or not, because it is the one trace a console
 * operator's own database credentials cannot edit — see this function's own
 * docblock for the full reasoning.
 */
describe("avisarRescate", () => {
  const ENTRADA = {
    id_usuario: 14,
    operacion: "RESCUE_MFA_RESET",
    detalle: "Se borraron todos sus factores de segundo paso.",
    actor: "consola: isaias@VPS-osefi (pid 4821)",
    ip: null,
  };

  it("sends exactly one message — to the company, never to the account holder", async () => {
    // Unlike `avisarPasswordRestablecida`, there is no "to the user" half:
    // a rescue runs precisely when that mailbox is not a reliable channel
    // any more (the phone is lost, or the address is what is being
    // replaced).
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    await avisarRescate(ENTRADA);
    expect(enviarCorreo).toHaveBeenCalledTimes(1);
    expect(enviarCorreo.mock.calls[0][0]).toMatchObject({ para: "seguridad@osefi.net" });
  });

  it("names the operation, the account, who asked, and from where", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    await avisarRescate({ ...ENTRADA, ip: "203.0.113.5" });
    const correo = enviarCorreo.mock.calls[0][0] as { asunto: string; texto: string };
    expect(correo.asunto).toContain("RESCUE_MFA_RESET");
    expect(correo.asunto).toContain("@Diego");
    expect(correo.texto).toContain("isaias@VPS-osefi");
    expect(correo.texto).toContain("203.0.113.5");
    expect(correo.texto).toContain("Se borraron todos sus factores de segundo paso.");
  });

  it("says 'consola del contenedor' rather than a blank when there is no IP", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    await avisarRescate(ENTRADA);
    const correo = enviarCorreo.mock.calls[0][0] as { texto: string };
    expect(correo.texto).toMatch(/consola/i);
  });

  it("reports enviado: false, and logs at error (not warn), when MAIL_SECURITY_TO is missing", async () => {
    // Louder than the other two notices above: for this family the mail *is*
    // the one surviving trace, not a courtesy copy.
    vi.stubEnv("MAIL_SECURITY_TO", "");
    const resultado = await avisarRescate(ENTRADA);
    expect(resultado).toEqual({ enviado: false });
    expect(enviarCorreo).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][1]).toMatch(/MAIL_SECURITY_TO/);
  });

  it("reports enviado: false and logs at error when Resend itself refuses the send", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    enviarCorreo.mockResolvedValueOnce({ ok: false });
    const resultado = await avisarRescate(ENTRADA);
    expect(resultado).toEqual({ enviado: false });
    expect(error).toHaveBeenCalledOnce();
  });

  it("reports enviado: true on an ordinary successful send", async () => {
    vi.stubEnv("MAIL_SECURITY_TO", "seguridad@osefi.net");
    const resultado = await avisarRescate(ENTRADA);
    expect(resultado).toEqual({ enviado: true });
    expect(error).not.toHaveBeenCalled();
  });

  it("does not stop to check the daily mail budget — deliberately not gated by mailBudget.ts", async () => {
    // A console invocation is its own OS process with its own copy of that
    // module's in-memory counter, so it cannot see what the server has spent
    // today and the server cannot see what the console just spent — see this
    // function's own docblock. Reconciling the two needs a database-backed
    // counter this plan does not build; the cheap, correct answer is to never
    // ask it, matching `avisarPasswordRestablecida` and `avisarCorreoCambiado`
    // above, neither of which calls it either.
    const src = readFileSync("src/auth/securityNotice.ts", "utf8");
    expect(src).not.toMatch(/consumirPresupuestoDeCorreo/);
  });
});

/**
 * The audit half of Task 7, pinned as a test rather than written down in a
 * report — a report is read once, a test is read every time it fails.
 *
 * Global Constraint #2: a token never reaches the bitácora. The five actions
 * this plan adds all carry an email address and an id in `metadata`, and the
 * one thing none of them may carry is the value that opens the account. This
 * checks the source rather than a call, because the failure mode is somebody
 * adding `token` to a `metadata` object months from now, in a path no test
 * happens to exercise.
 */
describe("no token ever reaches the bitácora", () => {
  const CONTROLLERS = [
    "src/controllers/email.controller.ts",
    "src/controllers/password.controller.ts",
    // `registrarRescateEnBitacora` writes the same kind of `metadata` object,
    // against the same table, for the operation most likely to be run by
    // somebody with a database handle already in hand.
    "src/auth/rescueCore.ts",
  ];

  it("has no metadata object mentioning a token in either recovery controller", () => {
    const offenders: string[] = [];
    for (const file of CONTROLLERS) {
      const src = readFileSync(file, "utf8");
      // Every `metadata: { ... }` literal, non-greedy to the closing brace.
      for (const m of src.matchAll(/metadata:\s*\{[^}]*\}/g)) {
        if (/token/i.test(m[0])) offenders.push(`${file} — ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still finds the metadata objects it is meant to be checking", () => {
    // Without this, deleting or renaming `metadata:` everywhere would make the
    // test above pass by finding nothing at all — the failure mode of every
    // scan-the-source assertion.
    const found = CONTROLLERS.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/metadata:\s*\{[^}]*\}/g)]);
    expect(found.length).toBeGreaterThanOrEqual(5);
  });
});
