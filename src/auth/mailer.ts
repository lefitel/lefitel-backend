// The one door every message in this codebase leaves by. No controller
// imports a provider: they call `enviarCorreo`, and what is behind it —
// since plan 4E a chain of five providers with relay (`mailRelay.ts`) — is
// this module's business. When that chain changes, only these three files
// change.
//
// This module keeps exactly two decisions of its own, and both are refusals:
//
// **Under a test runner it refuses to send, unconditionally, before it even
// checks whether the caller remembered to mock it.** The company's whole
// daily quota sits behind this function, the domain is young, and a bounce
// against a fresh domain teaches spam filters to distrust everything it
// sends next — including a stranger's password-reset link an hour later. A
// forgotten `vi.mock("./mailer.js", ...)` has to be harmless by construction,
// not by whoever remembered to add it. The SMTP transport factory in
// `mailProviders.ts` refuses a second time for the same reason.
//
// **Outside production, with no chain configured, it answers `{ ok: true }`
// and sends nothing.** That is the development fallback the rest of the
// flow is built against, and the relay says so in its log. **In production
// the same situation answers `{ ok: false }`** and an `error` line: `index.ts`
// refuses to boot on an empty chain, but the rescue console never runs that
// check, and with the mail variables missing from *its* environment a first
// draft answered `ok: true` — and `--set-email` recorded `enviado: true` in
// the bitácora for a notice nobody received (audit of Task 7).

import { enviar, type MotivoDeRelevo, type ResultadoRelevo } from "./mailRelay.js";
import { maskEmail } from "./maskEmail.js";
import { log } from "../utils/logger.js";

const mailLog = log("mailer");

/**
 * True while this process is a vitest run. Checked fresh on every call
 * rather than cached at module load — `mailer.test.ts` needs to flip these
 * two variables for one test at a time and restore them right after.
 *
 * Two independent signals, either one enough on its own: `NODE_ENV ===
 * "test"` still catches a future vitest that stops setting `VITEST`, and
 * `VITEST === "true"` still catches a wrapper script that overrides
 * `NODE_ENV` for its own purposes. Measured on this repo's real test run —
 * both are true simultaneously under `npx vitest run` — so either alone
 * already covers every real run; the second is insurance, not decoration,
 * the same reasoning `src/utils/logger.ts`'s own `underTest` already
 * applies with the same OR.
 */
function bajoTestRunner(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/**
 * Which flow a message belongs to — a **closed set, checked by the compiler**,
 * and the value that reaches each provider's budget line.
 *
 * It exists because the obvious thing to pass there is `asunto`, and `asunto`
 * is the wrong value twice over. Four of the eight subjects in this codebase
 * interpolate a username (`[Seguridad] Rescate ejecutado — reset-mfa: @jperez`),
 * so using them writes *who was rescued* into a log line that never named
 * anybody before. And a subject is unbounded text, which destroys the one
 * thing that field is for: adding up what each flow spent today. A union is
 * what makes both impossible rather than merely discouraged.
 *
 * Since plan 4E the flow also decides which share of a provider's budget a
 * message may spend — see `FLUJOS_RESERVADOS` in `mailBudget.ts`.
 */
export type FlujoDeCorreo =
  | "email/verificar"
  | "email/aviso-direccion-anterior"
  | "email/aviso-cambio"
  | "password/forgot"
  | "password/aviso-cambio"
  | "password/aviso-restablecida"
  | "rescate/aviso"
  // Plan 4E: the six-digit login code. On the login path, so the relay's
  // reserved share of each provider's budget is for this flow and the
  // security notices — see `mailBudget.ts`.
  | "mfa/codigo";

export interface CorreoAEnviar {
  para: string;
  asunto: string;
  /**
   * Required, not optional, so the compiler names every call site the day a
   * new flow appears — the same argument `texto` below makes for itself.
   */
  flujo: FlujoDeCorreo;
  html: string;
  /**
   * Plain-text body, required in the type rather than optional. A message
   * with no `text` part reads as spam to clients that score on that, and is
   * unreadable in the ones that never render HTML at all — see Global
   * Constraint #5 of the original mail task. Making the field mandatory in
   * the type is what stops a caller from finding that out by omission
   * instead of by the compiler refusing to build.
   */
  texto: string;
}

/**
 * What `enviarCorreo` answers. `ok` is the whole contract for six of its
 * eight callers; the rest is for the bitácora and the log: which provider
 * carried it, the provider's message id, and — when nothing went out — why.
 */
export interface ResultadoDeCorreo {
  ok: boolean;
  proveedor?: string;
  id?: string | null;
  motivo?: MotivoDeRelevo;
}

/**
 * Send one email, or say honestly that nothing was sent.
 *
 * Always resolves; never throws. **The caller must not change its HTTP
 * response based on `ok`** — doing so would enumerate who has an account
 * (Global Constraint #1) — so for the flows that are asked about an address
 * this is deliberately fire-and-forget from the caller's point of view.
 * **The one exception, by design (plan 4E): `POST /auth/mfa/email-code`.**
 * There the caller is already authenticated and the address is its own, so
 * nothing is enumerated by answering 503 when the code could not be sent —
 * and answering 200 would send the person to type a code that never left.
 *
 * `plazo_ms` bounds the whole walk of the chain. The flows with a person
 * waiting on the screen pass `MAIL_PLAZO_INTERACTIVO_MS`; the detached ones
 * take the default, `MAIL_PLAZO_DIFERIDO_MS`. Without a bound, nodemailer's
 * own per-phase timeouts add up to minutes per provider.
 *
 * Three ways this can end, in order:
 *
 * 1. Under the test runner: refuses unconditionally, logs the recipient and
 *    subject with a line that says plainly that nothing was sent, and
 *    returns `{ ok: true }`. Never touches any budget: every test in this
 *    codebase runs under this branch, and charging it here would let one
 *    test file's suite exhaust an in-memory counter a later file inherits.
 * 2. No chain configured (development, no `MAIL_PROVIDERS`, or nothing usable
 *    behind it): the relay logs and answers `{ ok: true, motivo:
 *    "desarrollo" }`, so the rest of the flow can be built and run locally
 *    without spending anybody's quota. In production the same answer is
 *    `{ ok: false, motivo: "desarrollo" }` — see the header.
 * 3. A configured chain: `mailRelay.enviar` walks it. Each provider's budget
 *    is charged once per message it actually carried (or may have carried),
 *    never per request — see the relay for what each class of failure does.
 */
export async function enviarCorreo(
  correo: CorreoAEnviar,
  opciones: { plazo_ms?: number } = {},
): Promise<ResultadoDeCorreo> {
  const para = maskEmail(correo.para);
  if (bajoTestRunner()) {
    mailLog.warn({ para, asunto: correo.asunto }, "correo NO enviado: el proceso corre bajo el test runner");
    return { ok: true };
  }

  let r: ResultadoRelevo;
  try {
    r = await enviar(correo, opciones);
  } catch (err) {
    // The relay catches every provider's failure; a throw here is a bug in
    // it. The contract is "always resolves", and the rescue console writes
    // to the bitácora on the strength of it.
    mailLog.error({ para, asunto: correo.asunto, err }, "correo NO enviado: el relevo lanzó una excepción");
    return { ok: false, motivo: "error" };
  }
  if (r.ok) return { ok: true, proveedor: r.proveedor, id: r.id };
  if (r.motivo === "desarrollo") {
    if (process.env.NODE_ENV === "production") {
      mailLog.error(
        { para, asunto: correo.asunto },
        "correo NO enviado: la cadena de proveedores está vacía en producción. Revisa MAIL_PROVIDERS y las variables de cada proveedor en el entorno de ESTE proceso",
      );
      return { ok: false, motivo: "desarrollo" };
    }
    mailLog.warn({ para, asunto: correo.asunto }, "correo NO enviado: sin proveedores configurados (modo desarrollo)");
    return { ok: true, motivo: "desarrollo" };
  }
  mailLog.error({ para, asunto: correo.asunto, motivo: r.motivo, proveedor: r.proveedor }, "correo NO enviado");
  return { ok: false, motivo: r.motivo, proveedor: r.proveedor };
}
