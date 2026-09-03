// `enviarCorreo` is the only door out, and since plan 4E what is behind it
// is the relay (`mailRelay.ts`, tested on its own). What this file pins is
// the door itself: the two refusals it keeps — the test runner and the
// development fallback — the additive shape of its answer, and the property
// `resend` is imported by exactly one file, which moved with the code.
//
// Every test here runs under vitest, so `bajoTestRunner()` answers `true`
// for free and the relay is never reached; the tests that need the door
// open stub `VITEST`/`NODE_ENV` for that one test and mock the relay, so no
// provider — real or fake — is ever constructed by this file.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const error = vi.fn();
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({ log: () => ({ error, warn, info: vi.fn(), debug: vi.fn() }) }));

const enviar = vi.fn();
vi.mock("./mailRelay.js", () => ({ enviar: (...a: unknown[]) => enviar(...a) }));

const { enviarCorreo } = await import("./mailer.js");

type CorreoAEnviar = Parameters<typeof enviarCorreo>[0];
const CORREO: CorreoAEnviar = {
  para: "destinatario@example.com",
  asunto: "Verifica tu correo",
  flujo: "email/verificar",
  html: "<p>hola</p>",
  texto: "hola",
};

function comoSiFueraProduccion(): void {
  vi.stubEnv("VITEST", "false");
  vi.stubEnv("NODE_ENV", "development");
}

beforeEach(() => {
  vi.clearAllMocks();
  enviar.mockResolvedValue({ ok: true, proveedor: "resend", id: "email_123" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("enviarCorreo — refuses to send while this is a test run", () => {
  it("never reaches the relay, whatever the environment holds", async () => {
    vi.stubEnv("MAIL_PROVIDERS", "resend,mailjet");
    vi.stubEnv("RESEND_API_KEY", "re_would_be_a_real_key");
    vi.stubEnv("MAIL_FROM", "info@osefi.net");
    const result = await enviarCorreo(CORREO);
    expect(result).toEqual({ ok: true });
    expect(enviar).not.toHaveBeenCalled();
    // Masked even here: a log line is a log line.
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ para: "d***@example.com" }), expect.stringContaining("test runner"));
  });

  it("still refuses when only NODE_ENV says test", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "test");
    expect(await enviarCorreo(CORREO)).toEqual({ ok: true });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("enviarCorreo — the door, when open", () => {
  it("hands the message and the caller's deadline to the relay, and answers who carried it", async () => {
    comoSiFueraProduccion();
    const result = await enviarCorreo(CORREO, { plazo_ms: 12_000 });
    expect(enviar).toHaveBeenCalledWith(CORREO, { plazo_ms: 12_000 });
    expect(result).toEqual({ ok: true, proveedor: "resend", id: "email_123" });
  });

  it("passes an absent deadline through as absent, so the relay applies its own default", async () => {
    comoSiFueraProduccion();
    await enviarCorreo(CORREO);
    expect(enviar).toHaveBeenCalledWith(CORREO, {});
  });

  it("answers ok:true and sends nothing in development mode, saying so", async () => {
    comoSiFueraProduccion();
    enviar.mockResolvedValue({ ok: false, motivo: "desarrollo" });
    const result = await enviarCorreo(CORREO);
    expect(result).toEqual({ ok: true, motivo: "desarrollo" });
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("desarrollo"));
  });

  it("answers ok:false with the relay's reason when nothing went out, and never throws", async () => {
    comoSiFueraProduccion();
    enviar.mockResolvedValue({ ok: false, motivo: "sin-proveedor" });
    const result = await enviarCorreo(CORREO);
    expect(result).toEqual({ ok: false, motivo: "sin-proveedor", proveedor: undefined });
    expect(error).toHaveBeenCalled();
  });

  it("answers ok:false with motivo 'error', and does not throw, when the relay itself throws", async () => {
    comoSiFueraProduccion();
    enviar.mockRejectedValue(new Error("bug en el relevo"));
    await expect(enviarCorreo(CORREO)).resolves.toEqual({ ok: false, motivo: "error" });
    expect(error).toHaveBeenCalled();
  });

  // 🔴 The rescue console runs without `index.ts`'s boot check; with the mail
  // variables missing from its environment the relay answers "desarrollo",
  // and recording that as sent put `enviado: true` in the bitácora for a
  // notice nobody received (audit of Task 7).
  it("in production, an empty chain is a failure, not the development fallback", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "production");
    enviar.mockResolvedValue({ ok: false, motivo: "desarrollo" });
    expect(await enviarCorreo(CORREO)).toEqual({ ok: false, motivo: "desarrollo" });
    expect(error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("producción"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the old callers' contract: `ok` is a boolean and nothing else is required", async () => {
    comoSiFueraProduccion();
    const { ok } = await enviarCorreo(CORREO);
    expect(typeof ok).toBe("boolean");
  });
});

describe("CorreoAEnviar — texto stays mandatory in the type", () => {
  it("does not compile without texto — the line above must still need @ts-expect-error", () => {
    // @ts-expect-error — `texto` is required; deleting it from the type turns this red.
    const sinTexto: CorreoAEnviar = { para: "a@b.c", asunto: "x", flujo: "email/verificar", html: "<p/>" };
    expect(sinTexto).toBeDefined();
  });
});

describe("resend stays imported by exactly one file", () => {
  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? tsFilesUnder(full) : full.endsWith(".ts") ? [full] : [];
    });
  }

  // The adapter (`mailProviders.ts`) and its own test, since plan 4E — the
  // code moved out of `mailer.ts` and the allowlist moved with it. The
  // property is the same: no controller ever talks to a provider.
  it("no file outside mailProviders.ts imports the resend package", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = tsFilesUnder(srcRoot)
      .filter((file) => !file.endsWith(`${join("auth", "mailProviders.ts")}`))
      .filter((file) => !file.endsWith(`${join("auth", "mailProviders.test.ts")}`))
      .filter((file) => /from\s+["']resend["']/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("and nodemailer likewise", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = tsFilesUnder(srcRoot)
      .filter((file) => !file.endsWith(`${join("auth", "mailProviders.ts")}`))
      .filter((file) => !file.endsWith(`${join("auth", "mailProviders.test.ts")}`))
      .filter((file) => /from\s+["']nodemailer["']/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
