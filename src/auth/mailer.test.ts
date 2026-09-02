// `enviarCorreo` is the only door to Resend, and the company's whole daily
// quota (100 sends) sits behind it. Every test in this file runs under
// vitest, which means `bajoTestRunner()` in `mailer.ts` answers `true` for
// free — so most of the tests below need no `resend` mock at all: the guard
// refuses before the module ever looks at it, and that refusal is itself
// the thing being tested.
//
// The two tests that exercise the actual Resend-calling branch stub
// `VITEST`/`NODE_ENV` for that one test only (`vi.stubEnv`, undone in
// `afterEach`) so the guard answers `false` just this once — and `resend` is
// mocked in this file regardless, so even if that stubbing failed for some
// reason, no real network call could happen. Two independent reasons this
// suite cannot reach the real API; see the report for why neither can be
// removed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared by `mailer.ts`'s own `mailLog` and `mailBudget.ts`'s `budgetLog` —
// both call `log(...)` from this same mocked module, so both loggers land in
// these two spies. That is what lets the tests below tell "the budget ran
// out" (mailBudget's own line, and mailer's) apart from "Resend rejected it"
// (mailer's line only) without needing two separate mocks.
const error = vi.fn();
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({ log: () => ({ error, warn, info: vi.fn(), debug: vi.fn() }) }));

const send = vi.fn();
// `new Resend(...)` is a real constructor call, and vitest's mock only wires
// that up correctly when the implementation is a `function` (or a class) —
// an arrow function silently drops the returned instance, which is why this
// is not `() => ({ emails: { send } })`. A plain `function` that explicitly
// returns an object also satisfies `new`, and unlike a class expression it
// keeps a plain call signature, so `mockImplementation` accepts it as-is.
function FakeResend() {
  return { emails: { send } };
}
const ResendMock = vi.fn().mockImplementation(FakeResend);
vi.mock("resend", () => ({ Resend: ResendMock }));

const { enviarCorreo } = await import("./mailer.js");
const { reiniciarPresupuestoDeCorreo, presupuestoRestante } = await import("./mailBudget.js");
const { MAIL_DAILY_BUDGET } = await import("../config/security.js");
type CorreoAEnviar = Parameters<typeof enviarCorreo>[0];

const CORREO: CorreoAEnviar = {
  para: "destinatario@example.com",
  asunto: "Verifica tu correo",
  flujo: "email/verificar",
  html: "<p>hola</p>",
  texto: "hola",
};

// Real, unmocked module state — a fresh window before every test, so no test
// in this file can see what an earlier one spent, and so a test that spends
// on purpose (see "enviarCorreo — the daily mail budget" below) starts from
// the same full budget every other test assumes it has.
beforeEach(() => {
  reiniciarPresupuestoDeCorreo();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("enviarCorreo — refuses to send while this is a test run", () => {
  it("never constructs a Resend client, real keys or not", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_would_be_a_real_key");
    vi.stubEnv("MAIL_FROM", "info@osefi.net");

    const result = await enviarCorreo(CORREO);

    expect(result).toEqual({ ok: true });
    expect(ResendMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // Never touches the daily budget — every test in this codebase runs
    // through this branch, and charging it here would let one file's suite
    // exhaust the counter a later file inherits.
    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET);
  });

  it("never sends with keys missing either", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");

    const result = await enviarCorreo(CORREO);

    expect(result).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET);
  });
});

describe("enviarCorreo — development fallback when keys are missing", () => {
  it("answers ok:true without sending when RESEND_API_KEY is absent", async () => {
    // Escapes the test-runner guard on purpose, to reach the *next* guard
    // (missing keys) instead. `resend` stays mocked throughout the file, so
    // this cannot become a real network call even though the first guard
    // is bypassed for this one test.
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "info@osefi.net");

    const result = await enviarCorreo(CORREO);

    expect(result).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
    // The one case Task 4 calls out by name: a development environment has
    // no real Resend quota to protect, so this path must never spend it —
    // charging here would let this file's own suite exhaust the budget
    // between test files and fail sends for reasons unrelated to what any
    // one of them is testing.
    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET);
  });
});

// Both guards escaped on purpose: the test-runner guard (so a call reaches
// the real-send branch at all) and a pair of made-up keys standing in for
// real ones (so the "keys missing" fallback does not intercept it first).
// `resend` is mocked for the whole file, so nothing that uses this ever
// reaches a socket regardless of these two stubs. File scope rather than
// local to one describe block: the budget block below needs it too, to
// reach the same branch `enviarCorreo` actually spends the quota in.
function comoSiFueraProduccion(): void {
  vi.stubEnv("VITEST", "false");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("MAIL_FROM", "info@osefi.net");
}

describe("enviarCorreo — talking to Resend", () => {
  it("sends the text body alongside the html body", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({ data: { id: "email_123" }, error: null });

    await enviarCorreo(CORREO);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.html).toBe(CORREO.html);
    expect(payload.text).toBe(CORREO.texto);
  });

  it("passes the recipient, subject and configured sender through untouched", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({ data: { id: "email_123" }, error: null });

    await enviarCorreo(CORREO);

    const payload = send.mock.calls[0][0];
    expect(payload.to).toBe(CORREO.para);
    expect(payload.subject).toBe(CORREO.asunto);
    expect(payload.from).toBe("info@osefi.net");
  });

  it("a 500 from Resend does not throw, and answers ok:false", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({
      data: null,
      error: { message: "Internal error", statusCode: 500, name: "internal_server_error" },
    });

    const result = await enviarCorreo(CORREO);

    expect(result).toEqual({ ok: false });
  });

  it("a rejected send (network failure before Resend answers) does not throw either", async () => {
    comoSiFueraProduccion();
    send.mockRejectedValue(new Error("fetch failed"));

    const result = await enviarCorreo(CORREO);

    expect(result).toEqual({ ok: false });
  });
});

/**
 * Decision 2 in `docs/plans/2026-09-01-defectos-previos-al-4b.md`: the
 * budget is spent here, once per message actually handed to Resend, and
 * nowhere else. The four properties this task's brief names by test name all
 * live in this describe block.
 */
describe("enviarCorreo — the daily mail budget", () => {
  it("charges one unit per message sent, not per request", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({ data: { id: "email_1" }, error: null });

    // Three real sends — what a single `/auth/email/send` request can
    // trigger today (the verification mail plus the previous-address
    // notice), and one more on top. A version that charged once per request
    // rather than once per message would leave two units unspent here.
    await enviarCorreo(CORREO);
    await enviarCorreo(CORREO);
    await enviarCorreo(CORREO);

    expect(send).toHaveBeenCalledTimes(3);
    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET - 3);
  });

  /**
   * `securityNotice.ts`'s three functions (`avisarPasswordRestablecida`,
   * `avisarCorreoCambiado`, `avisarRescate`) call this exact function and
   * nothing else — not imported here, on purpose: pulling in that module
   * means pulling in a real Sequelize model just to prove something that
   * lives entirely inside `enviarCorreo` itself. Before this task those three
   * never touched the budget, because the only charge in the codebase lived
   * in the two controllers and none of the three is ever called from one.
   * `enviarCorreo` has no branch that reads who is calling it or what the
   * message is for — so a call shaped exactly like one of theirs (their own
   * subject line, reused below) pays exactly like any other.
   */
  it("charges a call shaped like a security notice, which used to cost nothing at all", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({ data: { id: "email_1" }, error: null });

    await enviarCorreo({ ...CORREO, asunto: "Tu contraseña ha cambiado — Osefi" });

    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET - 1);
  });

  it("stops sending once the ceiling is reached, and logs why distinctly from a Resend failure", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({ data: { id: "email_1" }, error: null });
    for (let i = 0; i < MAIL_DAILY_BUDGET; i++) {
      await enviarCorreo(CORREO);
    }
    expect(send).toHaveBeenCalledTimes(MAIL_DAILY_BUDGET);
    error.mockClear();

    const resultado = await enviarCorreo(CORREO);

    expect(resultado).toEqual({ ok: false });
    // Not one more call reached Resend — the budget refused before dialling out.
    expect(send).toHaveBeenCalledTimes(MAIL_DAILY_BUDGET);
    const mensajes = error.mock.calls.map(([, mensaje]) => mensaje as string);
    expect(mensajes.some((m) => m.includes("presupuesto"))).toBe(true);
    expect(mensajes.some((m) => m.includes("Resend rechazó"))).toBe(false);
  });

  it("a Resend rejection is still logged as a Resend failure, not as a budget problem", async () => {
    comoSiFueraProduccion();
    send.mockResolvedValue({
      data: null,
      error: { message: "Internal error", statusCode: 500, name: "internal_server_error" },
    });

    const resultado = await enviarCorreo(CORREO);

    expect(resultado).toEqual({ ok: false });
    // The message was still sent to Resend — it just came back rejected —
    // so the budget was still spent for it, exactly like a successful send.
    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET - 1);
    const mensajes = error.mock.calls.map(([, mensaje]) => mensaje as string);
    expect(mensajes.some((m) => m.includes("Resend rechazó"))).toBe(true);
    expect(mensajes.some((m) => m.includes("presupuesto"))).toBe(false);
  });
});

describe("CorreoAEnviar — texto stays mandatory in the type", () => {
  it("does not compile without texto — the line above must still need @ts-expect-error", () => {
    // @ts-expect-error texto is required, not optional — see mailer.ts.
    // Making it optional there turns this into an unused-directive error
    // under `npm run typecheck`, which is the whole point: the guarantee
    // is enforced by the compiler on every run, not remembered by hand.
    const sinTexto: CorreoAEnviar = { para: "a@b.com", asunto: "x", html: "<p>x</p>" };
    expect(sinTexto.para).toBe("a@b.com");
  });
});

describe("resend stays imported by exactly one file", () => {
  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? tsFilesUnder(full) : full.endsWith(".ts") ? [full] : [];
    });
  }

  it("no file outside mailer.ts imports the resend package", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = tsFilesUnder(srcRoot)
      .filter((file) => !file.endsWith(`${join("auth", "mailer.ts")}`))
      .filter((file) => !file.endsWith(`${join("auth", "mailer.test.ts")}`))
      .filter((file) => /from\s+["']resend["']/.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });
});
