// The two adapters and the classification table — plan 4E, Task 7. The
// transport is a fake handed to `smtpProvider`, so nothing here opens a
// socket; the one test that asks the real factory proves it refuses under
// the runner, which is the second net behind `mailer.ts`'s own.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/logger.js", () => ({ log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

const send = vi.fn();
function FakeResend() {
  return { emails: { send } };
}
vi.mock("resend", () => ({ Resend: vi.fn().mockImplementation(FakeResend) }));

const createTransport = vi.fn();
vi.mock("nodemailer", () => ({ default: { createTransport: (...a: unknown[]) => createTransport(...a) } }));

const { smtpProvider, resendProvider, clasificarFalloSmtp, clasificarFalloResend, opcionesDeTransporte, fabricaNodemailer } =
  await import("./mailProviders.js");
const {
  MAIL_SMTP_CONNECTION_TIMEOUT_MS,
  MAIL_SMTP_GREETING_TIMEOUT_MS,
  MAIL_SMTP_SOCKET_TIMEOUT_MS,
  MAIL_SMTP_DNS_TIMEOUT_MS,
} = await import("../config/security.js");

const CORREO = {
  para: "ana@osefi.net",
  asunto: "Tu código de acceso — Osefi",
  flujo: "mfa/codigo" as const,
  html: "<p>123456</p>",
  texto: "123456",
};

const CFG = {
  tipo: "smtp" as const,
  nombre: "mailjet",
  host: "in-v3.mailjet.com",
  puerto: 587,
  usuarioVar: "MAIL_SMTP_MAILJET_USER",
  passVar: "MAIL_SMTP_MAILJET_PASS",
  cupoDiario: 180,
  cabeceras: { "X-Mailjet-TrackOpen": "0", "X-Mailjet-TrackClick": "0" },
};

const sendMail = vi.fn();
const close = vi.fn();
const fabrica = vi.fn(() => ({ sendMail, close }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAIL_SMTP_MAILJET_USER", "clave-publica");
  vi.stubEnv("MAIL_SMTP_MAILJET_PASS", "clave-privada");
  sendMail.mockResolvedValue({ messageId: "<abc@mailjet>" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the SMTP transport options — pinned, because nodemailer's defaults are the wrong ones", () => {
  it("demands STARTTLS and TLS 1.2, uses no pool, and bounds every phase", () => {
    expect(opcionesDeTransporte({ host: "h", puerto: 587 }, { user: "u", pass: "p" })).toEqual({
      host: "h",
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2" },
      pool: false,
      connectionTimeout: MAIL_SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: MAIL_SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: MAIL_SMTP_SOCKET_TIMEOUT_MS,
      dnsTimeout: MAIL_SMTP_DNS_TIMEOUT_MS,
      auth: { user: "u", pass: "p" },
    });
    expect(MAIL_SMTP_CONNECTION_TIMEOUT_MS + MAIL_SMTP_GREETING_TIMEOUT_MS + MAIL_SMTP_SOCKET_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });

  it("refuses to build a real transport under the test runner, whatever the environment holds", () => {
    expect(() => fabricaNodemailer(opcionesDeTransporte({ host: "h", puerto: 587 }, { user: "u", pass: "p" }))).toThrow(/test/);
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe("smtpProvider", () => {
  it("reads the credentials by variable name at send time and hands the message with the no-tracking headers", async () => {
    const p = smtpProvider(CFG, fabrica);
    const r = await p.enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(r).toEqual({ ok: true, id: "<abc@mailjet>" });
    expect(fabrica).toHaveBeenCalledWith(expect.objectContaining({ host: "in-v3.mailjet.com", port: 587, auth: { user: "clave-publica", pass: "clave-privada" } }));
    expect(sendMail).toHaveBeenCalledWith({
      from: "osefi@osefi.net",
      to: "ana@osefi.net",
      subject: CORREO.asunto,
      html: CORREO.html,
      text: CORREO.texto,
      headers: CFG.cabeceras,
    });
    expect(close).toHaveBeenCalled();
  });

  it("classifies a thrown SMTP error and still closes the transport", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("Can't send mail - all recipients were rejected"), { code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }));
    const p = smtpProvider(CFG, fabrica);
    const r = await p.enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(r).toMatchObject({ ok: false, clase: "destinatario" });
    expect(close).toHaveBeenCalled();
  });

  it("gives up as ambiguous when the attempt outlives its deadline", async () => {
    vi.useFakeTimers();
    sendMail.mockImplementation(() => new Promise(() => {}));
    const p = smtpProvider(CFG, fabrica);
    const pendiente = p.enviar(CORREO, "osefi@osefi.net", { plazo_ms: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);
    const r = await pendiente;
    expect(r).toMatchObject({ ok: false, clase: "ambiguo" });
    expect(close).toHaveBeenCalled();
  });

  it("answers an outage, not a throw, when the transport cannot even be built", async () => {
    const p = smtpProvider(CFG, () => {
      throw new Error("no hay red");
    });
    const r = await p.enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(r).toMatchObject({ ok: false, clase: "averia" });
  });
});

describe("clasificarFalloSmtp — the table, against nodemailer 9's own error shapes", () => {
  const casos: [string, Record<string, unknown>, string][] = [
    ["DNS", { code: "EDNS", command: "CONN", message: "getaddrinfo ENOTFOUND mail.x" }, "averia"],
    ["connection refused", { code: "ECONNECTION", command: "CONN", message: "connect ECONNREFUSED 1.2.3.4:587" }, "averia"],
    ["connection timeout", { code: "ETIMEDOUT", command: "CONN", message: "Connection timeout" }, "averia"],
    ["no greeting", { code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" }, "averia"],
    ["TLS", { code: "ETLS", command: "CONN", message: "wrong version number" }, "averia"],
    // The shape nodemailer 9 really produces when `requireTLS` meets a server
    // with no STARTTLS (`smtp-connection/index.js`: "EHLO failed but HELO does
    // not support required STARTTLS"). `EREQUIRETLS` is not it — that code
    // belongs to the RFC 8689 MAIL FROM parameter this adapter never sets.
    ["STARTTLS not offered", { code: "ECONNECTION", command: "EHLO", message: "EHLO failed but HELO does not support required STARTTLS. response=250 mail.x" }, "configuracion"],
    ["auth", { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, message: "Invalid login" }, "autenticacion"],
    // 🔴 A 535 whose text says "too many" is a refused login, not a quota.
    ["auth with quota-shaped words", { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, message: "535 Authentication failed: sending limit exceeded, upgrade your plan" }, "autenticacion"],
    ["greylisting", { code: "EENVELOPE", command: "RCPT TO", responseCode: 450, message: "try later" }, "temporal"],
    ["too many recipients", { code: "EENVELOPE", command: "RCPT TO", responseCode: 452, message: "Too many recipients" }, "temporal"],
    ["bad recipient", { code: "EENVELOPE", command: "RCPT TO", responseCode: 550, message: "no such user" }, "destinatario"],
    // 🔴 The audit's red finding: nodemailer stamps EENVELOPE on MAIL FROM and
    // on the DATA command too, and a refused *sender* filed as a refused
    // recipient killed every message at that provider without relaying.
    ["sender refused at MAIL FROM", { code: "EENVELOPE", command: "MAIL FROM", responseCode: 550, message: "Sender address rejected: not owned by user" }, "configuracion"],
    ["DATA command refused", { code: "EENVELOPE", command: "DATA", responseCode: 554, message: "Transaction failed" }, "contenido"],
    ["content refused", { code: "EMESSAGE", command: "DATA", responseCode: 554, message: "Message rejected" }, "contenido"],
    ["content deferred", { code: "EMESSAGE", command: "DATA", responseCode: 451, message: "try again" }, "temporal"],
    ["message too big", { code: "EMESSAGE", command: "DATA", responseCode: 552, message: "Message size exceeds fixed maximum message size" }, "contenido"],
    ["quota by text", { code: "EMESSAGE", command: "DATA", responseCode: 550, message: "Daily quota exceeded" }, "cuota"],
    ["sending limit by text", { code: "EENVELOPE", command: "RCPT TO", responseCode: 550, message: "Daily sending limit exceeded" }, "cuota"],
    // 421 is the standard transient "service not available": a relay, not a day written off.
    ["service not available", { code: "EENVELOPE", command: "RCPT TO", responseCode: 421, message: "Service not available, closing transmission channel" }, "temporal"],
    ["closed after DATA", { code: "ECONNECTION", command: "CONN", message: "Connection closed unexpectedly" }, "ambiguo"],
    ["idle timeout", { code: "ETIMEDOUT", command: "CONN", message: "Timeout" }, "ambiguo"],
    ["something else", { message: "boom" }, "averia"],
  ];
  for (const [nombre, err, clase] of casos) {
    it(`${nombre} → ${clase}`, () => {
      expect(clasificarFalloSmtp(err).clase).toBe(clase);
    });
  }

  it("never puts the body in the detail, only code, command, response code and a short message", () => {
    const { detalle } = clasificarFalloSmtp({ code: "EMESSAGE", command: "DATA", responseCode: 554, message: "x".repeat(500) });
    expect(detalle.length).toBeLessThan(260);
    expect(detalle).toContain("EMESSAGE DATA 554");
  });
});

describe("resendProvider", () => {
  beforeEach(() => vi.stubEnv("RESEND_API_KEY", "re_test"));

  it("sends through the SDK with the sender and the two bodies", async () => {
    send.mockResolvedValue({ data: { id: "email_123" }, error: null });
    const r = await resendProvider().enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(r).toEqual({ ok: true, id: "email_123" });
    expect(send).toHaveBeenCalledWith({ from: "osefi@osefi.net", to: CORREO.para, subject: CORREO.asunto, html: CORREO.html, text: CORREO.texto });
  });

  it("classifies Resend's own error names and codes", async () => {
    for (const [error, clase] of [
      // Two requests a second is a throughput signal: relay, no charge, no day written off.
      [{ statusCode: 429, name: "rate_limit_exceeded", message: "slow down" }, "temporal"],
      [{ statusCode: 429, name: "daily_quota_exceeded", message: "day spent" }, "cuota"],
      [{ statusCode: 429, name: "monthly_quota_exceeded", message: "month spent" }, "cuota"],
      [{ statusCode: 401, name: "missing_api_key", message: "bad key" }, "autenticacion"],
      // The key is fine and the request is refused: our sender domain, not their problem.
      [{ statusCode: 403, name: "validation_error", message: "The osefi.net domain is not verified" }, "configuracion"],
      [{ statusCode: 422, name: "validation_error", message: "Invalid `to` field" }, "destinatario"],
      [{ statusCode: 422, name: "validation_error", message: "Invalid `subject` field" }, "contenido"],
      [{ statusCode: 500, name: "internal_server_error", message: "boom" }, "averia"],
      [{ statusCode: 400, name: "invalid_parameter", message: "subject" }, "contenido"],
      // 🔴 The SDK never throws on a network failure: it answers this, with no
      // status. A first draft let it fall to `contenido` — charged and never sidelined.
      [{ statusCode: null, name: "application_error", message: "Unable to fetch data. The request could not be resolved." }, "averia"],
    ] as const) {
      expect(clasificarFalloResend(error).clase, error.name).toBe(clase);
    }
  });

  it("hands the SDK the key from the configured variable, and refuses before constructing it when the variable is empty", async () => {
    send.mockResolvedValue({ data: { id: "x" }, error: null });
    await resendProvider().enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 });
    const { Resend } = await import("resend");
    expect(Resend).toHaveBeenCalledWith("re_test");

    vi.mocked(Resend).mockClear();
    send.mockClear();
    vi.stubEnv("RESEND_API_KEY", "");
    const r = await resendProvider().enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(r).toMatchObject({ ok: false, clase: "autenticacion", detalle: expect.stringContaining("RESEND_API_KEY") });
    // Never constructed: the SDK would read the variable from the environment
    // on its own, or throw — and the throw would be filed as an outage.
    expect(Resend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("answers ok:false with a class on a Resend error, and never throws on a rejected send", async () => {
    send.mockResolvedValueOnce({ data: null, error: { message: "Internal error", statusCode: 500, name: "internal_server_error" } });
    expect(await resendProvider().enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 })).toMatchObject({ ok: false, clase: "averia" });
    send.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await resendProvider().enviar(CORREO, "osefi@osefi.net", { plazo_ms: 10_000 })).toMatchObject({ ok: false, clase: "averia" });
  });
});

describe("attachments — the scheduled reports' only way out", () => {
  const ADJUNTO = { nombre: "informe.xlsx", tipo: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contenido: Buffer.from("bytes") };

  it("hands them to the SMTP transport under nodemailer's own names", async () => {
    await smtpProvider(CFG, fabrica).enviar({ ...CORREO, adjuntos: [ADJUNTO] }, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: "informe.xlsx", content: ADJUNTO.contenido, contentType: ADJUNTO.tipo }],
      }),
    );
  });

  it("hands them to Resend under the SDK's own names", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    send.mockResolvedValue({ data: { id: "email_123" }, error: null });
    await resendProvider().enviar({ ...CORREO, adjuntos: [ADJUNTO] }, "osefi@osefi.net", { plazo_ms: 10_000 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: "informe.xlsx", content: ADJUNTO.contenido, contentType: ADJUNTO.tipo }],
      }),
    );
  });

  it("sends no `attachments` key at all for a message without them, and none for an empty list", async () => {
    // An empty `attachments: []` is harmless to both libraries today; the key
    // is left out so the eight account flows go on sending exactly the object
    // they always sent.
    vi.stubEnv("RESEND_API_KEY", "re_test");
    send.mockResolvedValue({ data: { id: "x" }, error: null });
    for (const correo of [CORREO, { ...CORREO, adjuntos: [] }]) {
      sendMail.mockClear();
      send.mockClear();
      await smtpProvider(CFG, fabrica).enviar(correo, "osefi@osefi.net", { plazo_ms: 10_000 });
      await resendProvider().enviar(correo, "osefi@osefi.net", { plazo_ms: 10_000 });
      expect(sendMail.mock.calls[0][0]).not.toHaveProperty("attachments");
      expect(send.mock.calls[0][0]).not.toHaveProperty("attachments");
    }
  });
});
