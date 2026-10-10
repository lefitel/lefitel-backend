// The two ways a message leaves this server — Resend by its API, everything
// else by SMTP through one adapter — behind one interface the relay
// (`mailRelay.ts`) walks. Plan 4E, Task 7; design §4.2 and §4.4.
//
// **Every failure is classified, because the relay reacts to the class and
// not to the error.** A first draft treated every rejection alike: one
// mistyped recipient answered `550` at four providers in a row, sidelined
// all four for a quarter of an hour, and charged four units for a message
// nobody could receive. The table in `clasificarFalloSmtp` is what an audit
// of that draft produced, read against nodemailer 9's own source
// (`smtp-connection/index.js`): which errors mean "this provider is down",
// which mean "this message is bad", which mean "this recipient is bad", and
// which mean "we cannot know whether it went out".
//
// **The last class is the honest one.** nodemailer stamps `command: 'CONN'`
// on every connection-level error whatever phase it happened in, so a socket
// that died after `DATA` and before the `250` is indistinguishable, by code,
// from one that died before the greeting. The message text tells them apart
// — "Connection timeout" and "Greeting never received" are before anything
// was sent; "Connection closed unexpectedly" and a bare "Timeout" may be
// after — and the relay relays on the ambiguous ones by decision (design
// §1.2.3): every payload this system sends is harmless in duplicate, and a
// person who cannot log in is not.
//
// **The SMTP adapter's options are fixed here and pinned by test**, because
// nodemailer's defaults are the wrong ones twice over: `requireTLS` is
// `false` (upgrade if offered, else carry on in the clear — the provider's
// password and the code in plaintext to whoever answers a hijacked DNS
// lookup), and the timeouts are two minutes per connection and ten per
// socket, per provider, with a person waiting on the login screen.
//
// **Under the test runner the transport factory refuses**, on top of
// `mailer.ts`'s own refusal. `database/sequelize.ts` loads `.env` into every
// test process; the day `MAIL_SMTP_*` lands in a developer's `.env`, a
// forgotten `vi.mock` would otherwise open a real socket with a real
// password. The factory is injectable, so the relay's tests never need to
// stub the environment to exercise it.

import nodemailer from "nodemailer";
import { Resend } from "resend";
import {
  MAIL_SMTP_CONNECTION_TIMEOUT_MS,
  MAIL_SMTP_GREETING_TIMEOUT_MS,
  MAIL_SMTP_SOCKET_TIMEOUT_MS,
  MAIL_SMTP_DNS_TIMEOUT_MS,
  type ProveedorConfigurado,
} from "../config/security.js";
import type { Adjunto, CorreoAEnviar } from "./mailer.js";

/**
 * What a failed attempt means to the relay:
 *
 * - `destinatario` — the address was refused (5xx at `RCPT TO`). Terminal for
 *   this message, harmless to the provider: no relay, no sideline, no charge.
 * - `contenido` — the message was refused after `DATA` (5xx). The provider
 *   said no explicitly and did the work: relay, charge, do not sideline.
 * - `temporal` — a 4xx (greylisting, "try later"). Relay; neither sideline
 *   nor charge — it is per message, not an outage.
 * - `averia` — DNS, connection refused, TLS, no greeting: the provider is
 *   unreachable. Relay; sideline after two in a row; do not charge.
 * - `autenticacion` — 535. The configuration is wrong and fifteen minutes
 *   change nothing: relay, sideline until restart, do not charge.
 * - `configuracion` — the provider refuses *us*, not the message: our sender
 *   rejected at `MAIL FROM` (the domain is not validated at that provider),
 *   or no STARTTLS where we demand it. Relay; do not charge; sideline until
 *   restart, and the log names the provider and what to check in its panel.
 *   An audit of the first draft found a `MAIL FROM` 5xx filed as
 *   `destinatario` — terminal — so every message died at that provider with
 *   four healthy ones untouched, and the log blamed the recipient.
 * - `cuota` — the provider says the day (or the month) is spent. Relay; mark
 *   the local budget spent and sideline until the window rolls. **Not** a
 *   per-second rate limit, a `421`, or a "too many recipients": those are
 *   `temporal`, because emptying a whole day over a throughput signal would
 *   have destroyed the reserve a takeover notice depends on.
 * - `ambiguo` — the socket died or went quiet after the body was sent. The
 *   message may have been delivered: relay (design §1.2.3) and charge. It
 *   also counts against the breaker: a socket that stalls on every message
 *   is a provider that is down, however each attempt has to be filed.
 */
export type ClaseDeFallo =
  | "destinatario"
  | "contenido"
  | "temporal"
  | "averia"
  | "autenticacion"
  | "configuracion"
  | "cuota"
  | "ambiguo";

// The `?: undefined` keys on each arm are what let `if (r.ok)` narrow with
// this repo's `strictNullChecks: false` — the same shape `finishLogin.ts`'s
// `ResultadoLogin` needed for the same reason.
export type ResultadoEnvio =
  | { ok: true; id: string | null; clase?: undefined; detalle?: undefined }
  | { ok: false; clase: ClaseDeFallo; detalle: string; id?: undefined };

export interface ProveedorDeCorreo {
  readonly nombre: string;
  enviar(correo: CorreoAEnviar, from: string, opciones: { plazo_ms: number }): Promise<ResultadoEnvio>;
}

/** What the SMTP adapter asks of whatever builds its transport — the seam the tests use. */
export interface TransporteSmtp {
  sendMail(mensaje: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
    attachments?: ArchivoAdjunto[];
  }): Promise<{ messageId?: string }>;
  close(): void;
}

/** One attachment, under the names nodemailer and Resend's SDK happen to share. */
interface ArchivoAdjunto {
  filename: string;
  content: Buffer;
  contentType: string;
}

/**
 * The attachments as a spreadable fragment: the key is absent, not empty,
 * when there is nothing to attach — so a message without files is handed to
 * both libraries as exactly the object it always was.
 */
function conAdjuntos(adjuntos: Adjunto[] | undefined): { attachments?: ArchivoAdjunto[] } {
  if (!adjuntos || adjuntos.length === 0) return {};
  return {
    attachments: adjuntos.map((a) => ({ filename: a.nombre, content: a.contenido, contentType: a.tipo })),
  };
}

export interface OpcionesDeTransporte {
  host: string;
  port: number;
  secure: false;
  requireTLS: true;
  tls: { minVersion: "TLSv1.2" };
  pool: false;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  dnsTimeout: number;
  auth: { user: string; pass: string };
}

export type FabricaDeTransporte = (opciones: OpcionesDeTransporte) => TransporteSmtp;

function bajoTestRunner(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/** The real factory: nodemailer, with the options above and nothing left to its defaults. */
export const fabricaNodemailer: FabricaDeTransporte = (opciones) => {
  if (bajoTestRunner()) {
    throw new Error("mailProviders: un test intentó abrir un transporte SMTP real; inyecta una fábrica falsa");
  }
  return nodemailer.createTransport(opciones) as unknown as TransporteSmtp;
};

/** The options every SMTP provider gets — one place, pinned by test. */
export function opcionesDeTransporte(
  cfg: { host: string; puerto: number },
  auth: { user: string; pass: string },
): OpcionesDeTransporte {
  return {
    host: cfg.host,
    port: cfg.puerto,
    secure: false,
    requireTLS: true,
    tls: { minVersion: "TLSv1.2" },
    pool: false,
    connectionTimeout: MAIL_SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: MAIL_SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: MAIL_SMTP_SOCKET_TIMEOUT_MS,
    dnsTimeout: MAIL_SMTP_DNS_TIMEOUT_MS,
    auth,
  };
}

/** A promise that settles as `"plazo"` after `ms`, for the races below. */
function plazo(ms: number): Promise<"plazo"> {
  return new Promise((resolve) => setTimeout(() => resolve("plazo"), ms).unref?.());
}

interface ErrorSmtp {
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

/**
 * Quota, by wording: a provider that has cut us off for the day answers with
 * an ordinary `5xx` and the difference is only in the text. Narrow on
 * purpose — "exceeded" alone also describes a message that is too big, and
 * "too many" also describes recipients — because the relay answers this
 * class by writing off a provider's whole day.
 */
const CUOTA = /quota|(daily|monthly|hourly|sending) limit|limit exceeded|exceeded .{0,30}limit/i;
const NO_ES_CUOTA = /size|recipients/i;

/**
 * The table the header describes, read against nodemailer 9's own source.
 *
 * Order matters twice. A `535` whose text says "too many failed attempts" is
 * a refused login, not a quota, so authentication is decided first. And
 * nodemailer stamps `EENVELOPE` on three different phases — `MAIL FROM`,
 * `RCPT TO` and the `DATA` command — so `command` is what tells a refused
 * *sender* (ours: `configuracion`) from a refused *recipient* (theirs:
 * `destinatario`) from a refused transaction (`contenido`).
 */
export function clasificarFalloSmtp(err: unknown): { clase: ClaseDeFallo; detalle: string } {
  const e = (typeof err === "object" && err !== null ? err : {}) as ErrorSmtp;
  const code = e.code ?? "";
  const command = e.command ?? "";
  const rc = e.responseCode ?? 0;
  const texto = `${e.response ?? ""} ${e.message ?? ""}`;
  const detalle = `${code || "?"}${command ? ` ${command}` : ""}${rc ? ` ${rc}` : ""}: ${(e.message ?? "").slice(0, 200)}`;

  if (code === "EAUTH" || rc === 535) return { clase: "autenticacion", detalle };
  if (CUOTA.test(texto) && !NO_ES_CUOTA.test(texto)) return { clase: "cuota", detalle };
  if (code === "EENVELOPE") {
    if (rc >= 500 && command === "RCPT TO") return { clase: "destinatario", detalle };
    if (rc >= 500 && command === "MAIL FROM") return { clase: "configuracion", detalle };
    // The `DATA` command refused before the body, or a 4xx anywhere in the
    // envelope — greylisting, "too many recipients", `421`.
    return { clase: rc >= 500 ? "contenido" : "temporal", detalle };
  }
  if (code === "EMESSAGE") {
    return { clase: rc >= 500 ? "contenido" : "temporal", detalle };
  }
  if (code === "EDNS" || code === "ETLS") return { clase: "averia", detalle };
  // `requireTLS` against a server that offers no STARTTLS: nodemailer reports
  // it as `ECONNECTION` on `EHLO` with this wording, never as `EREQUIRETLS`
  // (that code belongs to the RFC 8689 MAIL FROM parameter this adapter does
  // not use). The provider's port is wrong for us: until somebody fixes it.
  if (/STARTTLS/i.test(texto)) return { clase: "configuracion", detalle };
  if (code === "ECONNECTION" || code === "ESOCKET" || code === "ETIMEDOUT") {
    // Before anything was sent: the connection never opened, or the server
    // never greeted. Anything else on these codes may be after `DATA`.
    if (/Connection timeout|Greeting never received|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(texto)) {
      return { clase: "averia", detalle };
    }
    return { clase: "ambiguo", detalle };
  }
  return { clase: "averia", detalle };
}

/**
 * The generic SMTP adapter, instantiated once per provider. Credentials are
 * read from the environment at send time by variable *name* — the
 * configuration object never carries a secret, so it can be logged whole.
 */
export function smtpProvider(
  cfg: Extract<ProveedorConfigurado, { tipo: "smtp" }>,
  fabrica: FabricaDeTransporte = fabricaNodemailer,
): ProveedorDeCorreo {
  return {
    nombre: cfg.nombre,
    async enviar(correo, from, opciones) {
      const user = process.env[cfg.usuarioVar] ?? "";
      const pass = process.env[cfg.passVar] ?? "";
      let transporte: TransporteSmtp;
      try {
        transporte = fabrica(opcionesDeTransporte(cfg, { user, pass }));
      } catch (err) {
        return { ok: false, clase: "averia", detalle: `transporte: ${(err as Error).message}` };
      }
      try {
        const resultado = await Promise.race([
          transporte.sendMail({
            from,
            to: correo.para,
            subject: correo.asunto,
            html: correo.html,
            text: correo.texto,
            headers: cfg.cabeceras,
            ...conAdjuntos(correo.adjuntos),
          }),
          plazo(opciones.plazo_ms),
        ]);
        if (resultado === "plazo") {
          // The outer deadline: nodemailer's timers are per phase, not per
          // attempt, so a server that answers each step just under its limit
          // would otherwise hold the login for their sum. Past `DATA` this
          // is the ambiguous case by definition.
          return { ok: false, clase: "ambiguo", detalle: `plazo de ${opciones.plazo_ms} ms agotado` };
        }
        return { ok: true, id: resultado.messageId ?? null };
      } catch (err) {
        return { ok: false, ...clasificarFalloSmtp(err) };
      } finally {
        // `close()` on a non-pooled nodemailer transport does not reach the
        // connection a `sendMail` still in flight is using — it only drops
        // listeners. So a send the deadline cut short may still complete and
        // deliver, which is exactly why the deadline answers `ambiguo` and
        // the design accepts a second copy (§1.2.3). Closing is still right
        // for the transports that did finish.
        try {
          transporte.close();
        } catch {
          // Nothing left to release.
        }
      }
    },
  };
}

interface ErrorResend {
  /** `null`, not absent, when the SDK could not reach the API at all. */
  statusCode?: number | null;
  name?: string;
  message?: string;
}

/**
 * Resend's own error names and codes, mapped to the same classes — read
 * against the SDK's `ErrorResponse` type and its `fetchRequest`, which
 * **never throws**: a network failure comes back as `application_error` with
 * `statusCode: null`. An audit of the first draft found that case falling to
 * the default `contenido` — charged, breaker reset, never sidelined — the
 * exact "firewall eats a quota in silence" the relay's header promises not
 * to allow.
 */
export function clasificarFalloResend(error: ErrorResend): { clase: ClaseDeFallo; detalle: string } {
  const detalle = `${error.name ?? "?"} ${error.statusCode ?? "sin-estado"}: ${(error.message ?? "").slice(0, 200)}`;
  const status = error.statusCode ?? null;
  const nombre = error.name ?? "";
  if (status === null) return { clase: "averia", detalle };
  if (nombre === "daily_quota_exceeded" || nombre === "monthly_quota_exceeded") return { clase: "cuota", detalle };
  // Two requests per second is a throughput signal, not a quota: relay, and
  // neither charge nor write the day off.
  if (status === 429 || nombre === "rate_limit_exceeded") return { clase: "temporal", detalle };
  if (status === 401) return { clase: "autenticacion", detalle };
  // The key is good and the request is refused anyway: the sender domain is
  // not verified at Resend, or the key is restricted. Ours to fix.
  if (status === 403) return { clase: "configuracion", detalle };
  if (status === 422 && /\bto\b|recipient/i.test(error.message ?? "")) return { clase: "destinatario", detalle };
  if (status >= 500) return { clase: "averia", detalle };
  return { clase: "contenido", detalle };
}

/**
 * Resend by its API — the code `mailer.ts` used to hold, moved here so the
 * relay sees one interface. The key is read at send time by variable name.
 */
export function resendProvider(claveVar = "RESEND_API_KEY"): ProveedorDeCorreo {
  return {
    nombre: "resend",
    async enviar(correo, from, opciones) {
      const apiKey = process.env[claveVar] ?? "";
      // Checked here and not left to the SDK: given an empty key its
      // constructor reads `RESEND_API_KEY` from the environment on its own —
      // a variable this configuration may not have named — and throws
      // otherwise, which the catch below would file as an outage with a
      // fifteen-minute cooldown instead of naming the variable to fix.
      if (apiKey === "") {
        return { ok: false, clase: "autenticacion", detalle: `la variable ${claveVar} está vacía` };
      }
      try {
        const resultado = await Promise.race([
          new Resend(apiKey).emails.send({
            from,
            to: correo.para,
            subject: correo.asunto,
            html: correo.html,
            text: correo.texto,
            ...conAdjuntos(correo.adjuntos),
          }),
          plazo(opciones.plazo_ms),
        ]);
        if (resultado === "plazo") {
          return { ok: false, clase: "ambiguo", detalle: `plazo de ${opciones.plazo_ms} ms agotado` };
        }
        const { data, error } = resultado;
        if (error) {
          // `error` is Resend's own `{ message, statusCode, name }` — never the
          // body, which is where a verification or reset token lives.
          return { ok: false, ...clasificarFalloResend(error as ErrorResend) };
        }
        return { ok: true, id: data?.id ?? null };
      } catch (err) {
        // The SDK answers network failures as `application_error` with no
        // status (see `clasificarFalloResend`); this is for a throw it does
        // not document. Still an outage, never a refusal.
        return { ok: false, clase: "averia", detalle: `excepción: ${(err as Error).message ?? String(err)}` };
      }
    },
  };
}
