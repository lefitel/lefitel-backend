// `POST /auth/mfa/email-code` — each step of the order the header calls the
// design, one test per step, and the two properties an audit of the first
// draft made explicit: the chain is asked *before* anything is minted, and a
// code that could not be sent is *not* invalidated.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findByPk = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => findByPk(...a) },
}));

const emitirCodigo = vi.fn();
const purgarCodigosCaducados = vi.fn();
vi.mock("../auth/emailCodeStore.js", () => ({
  emitirCodigo: (...a: unknown[]) => emitirCodigo(...a),
  purgarCodigosCaducados: (...a: unknown[]) => purgarCodigosCaducados(...a),
}));

const enviarCorreo = vi.fn();
vi.mock("../auth/mailer.js", () => ({ enviarCorreo: (...a: unknown[]) => enviarCorreo(...a) }));

const hayProveedorDisponible = vi.fn();
vi.mock("../auth/mailRelay.js", () => ({
  hayProveedorDisponible: (...a: unknown[]) => hayProveedorDisponible(...a),
}));

// Real `estaBloqueada` (a pure function) without dragging express-rate-limit in.
vi.mock("../middleware/loginLimiters.js", () => ({
  estaBloqueada: (u: { locked_until?: Date | null }) =>
    !!u.locked_until && new Date(u.locked_until).getTime() > Date.now(),
}));

vi.mock("./mfa.controller.js", () => ({ CODIGO_MFA_INVALIDO: "Código incorrecto o ya utilizado." }));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  sendEmailCode,
  codeEmailBody,
  CORREO_NO_VERIFICADO,
  ESPERA_ANTES_DE_REENVIAR,
  CODIGO_NO_ENVIADO,
  CODIGO_ENVIADO,
} = await import("./emailCode.controller.js");
const { EMAIL_CODE_RESEND_SECONDS } = await import("../config/security.js");

const YO = 7;
const SESION = "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa";
const CALLER = { id: YO, id_rol: 2, id_sesion: SESION, expires_at: new Date(), estado: "parcial" as const, mfa_satisfied_at: null };

function cuenta(overrides: Record<string, unknown> = {}) {
  return {
    dataValues: {
      id: YO,
      email: "isaias@osefi.net",
      email_verified_at: new Date("2026-09-01T00:00:00Z"),
      failed_attempts: 0,
      locked_until: null,
      ...overrides,
    },
  };
}

function call(user: Record<string, unknown> | null = CALLER) {
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
    req: { body: {}, ip: "203.0.113.9", originalUrl: "/api/auth/mfa/email-code", user } as unknown as Request,
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

const lineaDe = (accion: string) =>
  logAction.mock.calls
    .map((c) => c[0] as { action: string; severity?: string; metadata?: Record<string, unknown> })
    .find((l) => l.action === accion);

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue(cuenta());
  hayProveedorDisponible.mockReturnValue(true);
  emitirCodigo.mockResolvedValue({ codigo: "123456" });
  enviarCorreo.mockResolvedValue({ ok: true, proveedor: "resend", id: "msg-1" });
  purgarCodigosCaducados.mockResolvedValue(0);
});

describe("the order of the checks", () => {
  it("1. refuses without a session, touching nothing", async () => {
    const c = call(null);
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(401);
    expect(findByPk).not.toHaveBeenCalled();
  });

  it("1. answers the inactive-account sentence when the row is gone", async () => {
    findByPk.mockResolvedValue(null);
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(401);
    expect(c.message).toBe("Su cuenta ya no está activa.");
  });

  it("1. spends no mail on a locked account — the same 400 its siblings give", async () => {
    findByPk.mockResolvedValue(cuenta({ locked_until: new Date(Date.now() + 60_000) }));
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.payload).toEqual({ message: "Código incorrecto o ya utilizado.", intentosRestantes: 0 });
    expect(hayProveedorDisponible).not.toHaveBeenCalled();
    expect(emitirCodigo).not.toHaveBeenCalled();
  });

  it("2. refuses an account with no verified address, before asking the chain", async () => {
    findByPk.mockResolvedValue(cuenta({ email_verified_at: null }));
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CORREO_NO_VERIFICADO);
    expect(hayProveedorDisponible).not.toHaveBeenCalled();
    expect(emitirCodigo).not.toHaveBeenCalled();
  });

  it("2. treats a missing address the same as an unverified one", async () => {
    findByPk.mockResolvedValue(cuenta({ email: null, email_verified_at: null }));
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(400);
    expect(c.message).toBe(CORREO_NO_VERIFICADO);
  });

  // 🔴 The property the audit named: ask the chain before burning anything.
  it("3. answers 503 and mints nothing when no provider can send, so the pending code stays valid", async () => {
    hayProveedorDisponible.mockReturnValue(false);
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(503);
    expect(c.message).toBe(CODIGO_NO_ENVIADO);
    expect(hayProveedorDisponible).toHaveBeenCalledWith("mfa/codigo");
    expect(emitirCodigo).not.toHaveBeenCalled();
    expect(enviarCorreo).not.toHaveBeenCalled();
    expect(lineaDe("MFA_EMAIL_CODE_FAILED")).toMatchObject({
      severity: "warning",
      metadata: expect.objectContaining({ motivo: "sin-proveedor", id_sesion: SESION }),
    });
  });

  it("4. answers 429 with the seconds to wait when the store refuses, sending nothing", async () => {
    emitirCodigo.mockResolvedValue({ rechazado: "tope-hora", reintento_en_s: 540 });
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(429);
    expect(c.payload).toEqual({ message: ESPERA_ANTES_DE_REENVIAR, reintento_en_s: 540 });
    expect(enviarCorreo).not.toHaveBeenCalled();
  });

  it("5. mints for the caller's own account and address, and mails the code under the mfa/codigo flow", async () => {
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(emitirCodigo).toHaveBeenCalledWith(YO, "isaias@osefi.net");
    expect(enviarCorreo).toHaveBeenCalledTimes(1);
    const correo = enviarCorreo.mock.calls[0][0] as Record<string, string>;
    expect(correo).toMatchObject({ para: "isaias@osefi.net", flujo: "mfa/codigo", asunto: "Tu código de acceso — Osefi" });
    expect(correo.html).toContain("123456");
    expect(correo.texto).toContain("123456");
    // The code is in the body and nowhere near the subject.
    expect(correo.asunto).not.toContain("123456");
  });

  // 🔴 The other property: a code that could not be sent is not invalidated.
  it("6. answers 503 when the send failed, and leaves the code alone", async () => {
    enviarCorreo.mockResolvedValue({ ok: false, motivo: "sin-proveedor" });
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(503);
    expect(c.message).toBe(CODIGO_NO_ENVIADO);
    expect(emitirCodigo).toHaveBeenCalledTimes(1);
    expect(lineaDe("MFA_EMAIL_CODE_FAILED")).toMatchObject({
      severity: "warning",
      metadata: expect.objectContaining({ motivo: "sin-proveedor", proveedor: null, enviado_a: "i***@osefi.net" }),
    });
    expect(lineaDe("MFA_EMAIL_CODE_SENT")).toBeUndefined();
  });

  it("6. names the provider that refused the recipient, and falls back to 'envio' when the relay gave no reason", async () => {
    enviarCorreo.mockResolvedValue({ ok: false, motivo: "destinatario", proveedor: "mailjet" });
    let c = call();
    await sendEmailCode(c.req, c.res);
    expect(lineaDe("MFA_EMAIL_CODE_FAILED")?.metadata).toMatchObject({ motivo: "destinatario", proveedor: "mailjet" });
    logAction.mockClear();
    enviarCorreo.mockResolvedValue({ ok: false });
    c = call();
    await sendEmailCode(c.req, c.res);
    expect(lineaDe("MFA_EMAIL_CODE_FAILED")?.metadata).toMatchObject({ motivo: "envio", proveedor: null });
  });

  it("7. answers 200 with the masked address and the cooldown, and files the line", async () => {
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(200);
    expect(c.payload).toEqual({
      message: CODIGO_ENVIADO,
      enviado_a: "i***@osefi.net",
      reintento_en_s: EMAIL_CODE_RESEND_SECONDS,
    });
    // The provider and its id are what answer "no me llegó" (design §3.4).
    expect(lineaDe("MFA_EMAIL_CODE_SENT")).toMatchObject({
      severity: "info",
      metadata: { id_sesion: SESION, enviado_a: "i***@osefi.net", proveedor: "resend", id_correo: "msg-1" },
    });
  });
});

describe("what never leaves the server", () => {
  it("puts the plain code in no response and no bitácora line", async () => {
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(JSON.stringify(c.payload)).not.toContain("123456");
    expect(JSON.stringify(logAction.mock.calls)).not.toContain("123456");
  });

  it("never spells the full address out in the response or the bitácora", async () => {
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(JSON.stringify(c.payload)).not.toContain("isaias@osefi.net");
    expect(JSON.stringify(logAction.mock.calls)).not.toContain("isaias@osefi.net");
  });
});

describe("the message", () => {
  it("carries no link: a login-code mail with a link is the phishing template", () => {
    const { html, texto } = codeEmailBody("123456");
    expect(html).not.toMatch(/<a\s|https?:\/\//);
    expect(texto).not.toMatch(/https?:\/\//);
  });

  it("says how long the code lasts and what a code you did not ask for means", () => {
    const { html, texto } = codeEmailBody("123456");
    for (const cuerpo of [html, texto]) {
      expect(cuerpo).toContain("10 minutos");
      expect(cuerpo).toContain("alguien conoce tu contraseña");
    }
  });
});

describe("the sweep", () => {
  it("purges expired codes after sending, without awaiting it and without failing the request", async () => {
    let resolver!: (n: number) => void;
    purgarCodigosCaducados.mockReturnValue(new Promise<number>((r) => (resolver = r)));
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(c.status).toBe(200);
    expect(purgarCodigosCaducados).toHaveBeenCalledTimes(1);
    resolver(3);
  });

  it("logs a failed sweep at warn and still answers 200", async () => {
    purgarCodigosCaducados.mockRejectedValue(new Error("la base de datos dijo que no"));
    const c = call();
    await sendEmailCode(c.req, c.res);
    await new Promise((r) => setImmediate(r));
    expect(c.status).toBe(200);
    expect(warn).toHaveBeenCalled();
  });

  it("does not sweep when nothing was minted", async () => {
    hayProveedorDisponible.mockReturnValue(false);
    const c = call();
    await sendEmailCode(c.req, c.res);
    expect(purgarCodigosCaducados).not.toHaveBeenCalled();
  });
});
