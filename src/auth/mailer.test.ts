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
import { afterEach, describe, expect, it, vi } from "vitest";

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
type CorreoAEnviar = Parameters<typeof enviarCorreo>[0];

const CORREO: CorreoAEnviar = {
  para: "destinatario@example.com",
  asunto: "Verifica tu correo",
  html: "<p>hola</p>",
  texto: "hola",
};

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
  });

  it("never sends with keys missing either", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");

    const result = await enviarCorreo(CORREO);

    expect(result).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
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
  });
});

describe("enviarCorreo — talking to Resend", () => {
  // Both guards escaped on purpose for this block only: the test-runner
  // guard (so the call below is reachable at all) and a pair of made-up
  // keys standing in for real ones (so the "keys missing" fallback does not
  // intercept it first). `resend` is mocked for the whole file, so nothing
  // here ever reaches a socket regardless of these two stubs.
  function comoSiFueraProduccion(): void {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "info@osefi.net");
  }

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
