// The one function in this codebase that talks to Resend, and the reason
// there is only one: no controller — not email verification, not password
// reset — imports `resend` directly. If a second provider is ever needed
// (Resend suspends the account, or the daily quota bites) only this file
// changes. Not written today: the quota is 3,000/month against real traffic
// of a few dozen, and the escape hatch for "email is down" is the rescue
// account from spec §8, not a second SMTP client.
//
// The quota is also why this module refuses to send for real under a test
// runner, unconditionally, before it even checks whether the caller
// remembered to mock it. The company's whole daily budget is 100 sends, the
// domain went live yesterday with no delivery history of its own, and a
// bounce against a fresh domain teaches spam filters to distrust everything
// it sends next — including a stranger's password-reset link an hour later.
// A forgotten `vi.mock("./mailer.js", ...)` has to be harmless by
// construction, not by whoever remembered to add it.

import { Resend } from "resend";
import { log } from "../utils/logger.js";
import { consumirPresupuestoDeCorreo } from "./mailBudget.js";

const mailLog = log("mailer");

/**
 * True while this process is a vitest run. Checked fresh on every call
 * rather than cached at module load — `mailer.test.ts` needs to flip these
 * two variables for one test at a time and restore them right after, to
 * exercise the Resend-calling branch below with `resend` mocked.
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

/** The one message this module knows how to send, and its only shape. */
/**
 * Which flow a message belongs to — a **closed set, checked by the compiler**,
 * and the value that reaches the mail budget's log line.
 *
 * It exists because the obvious thing to pass there is `asunto`, and `asunto`
 * is the wrong value twice over. Four of the seven subjects in this codebase
 * interpolate a username (`[Seguridad] Rescate ejecutado — reset-mfa: @jperez`),
 * so using them writes *who was rescued* into a log line that never named
 * anybody before. And a subject is unbounded text, which destroys the one
 * thing that field is for: adding up what each flow spent today. A union is
 * what makes both impossible rather than merely discouraged.
 */
export type FlujoDeCorreo =
  | "email/verificar"
  | "email/aviso-direccion-anterior"
  | "email/aviso-cambio"
  | "password/forgot"
  | "password/aviso-cambio"
  | "password/aviso-restablecida"
  | "rescate/aviso";

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
   * Constraint #5. One was measured to arrive anyway on 2026-08-24, but that
   * was the credit of a domain with a clean slate, not evidence that
   * skipping it is fine — the slate will not stay clean for long. Making
   * the field mandatory in the type is what stops a caller from finding
   * that out by omission instead of by the compiler refusing to build.
   */
  texto: string;
}

/**
 * Send one email, or say honestly that nothing was sent.
 *
 * Always resolves; never throws. The caller must not change its HTTP
 * response based on `ok` — doing so would enumerate who has an account
 * (Global Constraint #1) — so this is deliberately fire-and-forget from the
 * caller's point of view. The return value exists for logging and for this
 * module's own tests, not for a controller to branch a response on.
 *
 * Four ways this can end, in order:
 *
 * 1. Under the test runner: refuses unconditionally, logs the recipient and
 *    subject with a line that says plainly that nothing was sent, and
 *    returns `{ ok: true }`. This is the branch that makes a forgotten mock
 *    harmless — see the module header above. Never touches the daily budget:
 *    every test in this codebase runs under this branch, and charging it
 *    here would let one test file's suite exhaust the same in-memory counter
 *    a later file inherits, failing sends for reasons that have nothing to
 *    do with what that file is testing.
 * 2. `RESEND_API_KEY` or `MAIL_FROM` missing: the development fallback the
 *    Task 3 brief asks for, so the rest of the flow can be built and run
 *    locally without spending quota. Reachable only outside production —
 *    `requiredEnv` in `config/security.ts` refuses to boot a production
 *    process missing either variable, so this branch and a production
 *    deployment are mutually exclusive by construction, not by trusting
 *    that nobody deploys without them. Does not touch the budget either, for
 *    the plain reason that a development environment has no real Resend
 *    quota to protect.
 * 3. The daily budget (`auth/mailBudget.ts`) has none left: this is the one
 *    call site in the whole codebase for `consumirPresupuestoDeCorreo` —
 *    once per message actually about to reach Resend, which is what makes a
 *    request that sends no mail cost nothing and a request that sends three
 *    messages cost three (see Decision 2 in
 *    `docs/plans/2026-09-01-defectos-previos-al-4b.md`). Logged with its own
 *    line, distinct from a Resend rejection below — a caller that only reads
 *    `{ ok: false }` (six of the seven that call this function do not even
 *    do that) cannot otherwise tell "the quota ran out" apart from "Resend
 *    turned it down", and the two call for different reactions from whoever
 *    reads the log.
 * 4. Budget available, keys present, not under test: actually calls Resend.
 *    A 4xx/5xx from Resend is logged and answered with `{ ok: false }`; a
 *    promise that rejects before Resend ever answers (a network failure,
 *    say) is caught and answered the same way. Either way this function
 *    does not throw.
 */
export async function enviarCorreo(correo: CorreoAEnviar): Promise<{ ok: boolean }> {
  if (bajoTestRunner()) {
    mailLog.warn(
      { para: correo.para, asunto: correo.asunto },
      "correo NO enviado: el proceso corre bajo el test runner",
    );
    return { ok: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) {
    mailLog.warn(
      { para: correo.para, asunto: correo.asunto },
      "correo NO enviado: faltan RESEND_API_KEY o MAIL_FROM (modo desarrollo)",
    );
    return { ok: true };
  }

  // The one place this module ever spends the daily budget — see
  // `auth/mailBudget.ts` and the docstring above. `correo.asunto` doubles as
  // the log's `motivo`: it already names which flow this message belongs to
  // (verification, reset, a security notice), so there is no separate label
  // to keep in sync with the templates that set it.
  if (!consumirPresupuestoDeCorreo(correo.flujo)) {
    mailLog.error(
      { para: correo.para, asunto: correo.asunto },
      "correo NO enviado: se agotó el presupuesto diario de correo (esto no es un fallo de Resend)",
    );
    return { ok: false };
  }

  try {
    const { data, error } = await new Resend(apiKey).emails.send({
      from,
      to: correo.para,
      subject: correo.asunto,
      html: correo.html,
      text: correo.texto,
    });

    if (error) {
      // `error` is Resend's own `{ message, statusCode, name }` — never the
      // body, which is where a verification or reset token lives. Logging
      // it is exactly what Global Constraint #2 permits: metadata about the
      // failed attempt, not the credential.
      mailLog.error({ para: correo.para, asunto: correo.asunto, error }, "Resend rechazó el envío");
      return { ok: false };
    }

    mailLog.info({ para: correo.para, asunto: correo.asunto, id: data.id }, "correo enviado");
    return { ok: true };
  } catch (err) {
    mailLog.error({ para: correo.para, asunto: correo.asunto, err }, "fallo inesperado enviando correo");
    return { ok: false };
  }
}
