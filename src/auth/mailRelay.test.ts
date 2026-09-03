// The chain — plan 4E, Task 7. Fake providers that answer whatever a test
// says, real budgets, real breaker, real clock unless a test freezes it. Each
// row of the classification table is one test, and the property the design
// names first — a message goes out at most once by refusal, at most twice by
// ambiguity — has its own.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const error = vi.fn();
const warn = vi.fn();
const info = vi.fn();
vi.mock("../utils/logger.js", () => ({ log: () => ({ error, warn, info, debug: vi.fn() }) }));

const { configurarRelevo, reiniciarRelevo, enviar, hayProveedorDisponible, estadoDeLaCadena } =
  await import("./mailRelay.js");
const { MAIL_PROVIDER_COOLDOWN_MS, MAIL_DAILY_WINDOW_MS, MAIL_PLAZO_POR_INTENTO_MS, MAIL_RESERVA_FRACCION } =
  await import("../config/security.js");
type ProveedorDeCorreo = import("./mailProviders.js").ProveedorDeCorreo;
type ResultadoEnvio = import("./mailProviders.js").ResultadoEnvio;
type ProveedorConfigurado = import("../config/security.js").ProveedorConfigurado;

const CORREO = {
  para: "ana@osefi.net",
  asunto: "Tu código de acceso — Osefi",
  flujo: "mfa/codigo" as const,
  html: "<p>123456</p>",
  texto: "123456",
};
const VERIFICACION = { ...CORREO, flujo: "email/verificar" as const, asunto: "Verifica tu correo" };

/** A fake provider: a queue of answers, and a record of every call. */
function falso(nombre: string, respuestas: ResultadoEnvio[] = []) {
  const enviar = vi.fn(async () => respuestas.shift() ?? ({ ok: true, id: `${nombre}-id` } as ResultadoEnvio));
  const proveedor: ProveedorDeCorreo = { nombre, enviar };
  return { proveedor, enviar, respuestas };
}

/** One SMTP provider's configuration, as `configuracionDeCorreo` would build it. */
const cfg = (nombre: string, cupo = 100): ProveedorConfigurado => ({
  tipo: "smtp",
  nombre,
  host: "h",
  puerto: 587,
  usuarioVar: "U",
  passVar: "P",
  cupoDiario: cupo,
  cabeceras: {},
});

/** Configure the chain with fakes, in order, each with the given daily ceiling. */
function cadena(...entradas: { nombre: string; cupo?: number; respuestas?: ResultadoEnvio[] }[]) {
  const falsos = new Map(entradas.map((e) => [e.nombre, falso(e.nombre, e.respuestas ?? [])]));
  const proveedores = entradas.map((e) => cfg(e.nombre, e.cupo ?? 100));
  configurarRelevo(
    { ok: true, modo: "envia", from: "osefi@osefi.net", proveedores, descartados: [] },
    (cfg) => falsos.get(cfg.nombre)!.proveedor,
  );
  return falsos;
}

type ClaseDeFallo = import("./mailProviders.js").ClaseDeFallo;
const fallo = (clase: ClaseDeFallo): ResultadoEnvio => ({ ok: false, clase, detalle: `simulado ${clase}` });

beforeEach(() => {
  vi.clearAllMocks();
  reiniciarRelevo();
});
afterEach(() => vi.useRealTimers());

describe("the order and the first acceptance", () => {
  it("sends by the first provider and calls nobody else", async () => {
    const f = cadena({ nombre: "resend" }, { nombre: "mailjet" });
    const r = await enviar(CORREO);
    expect(r).toEqual({ ok: true, proveedor: "resend", id: "resend-id" });
    expect(f.get("resend")!.enviar).toHaveBeenCalledTimes(1);
    expect(f.get("mailjet")!.enviar).not.toHaveBeenCalled();
  });

  it("hands each provider the sender, the message and a per-attempt deadline", async () => {
    const f = cadena({ nombre: "resend" });
    await enviar(CORREO, { plazo_ms: 60_000 });
    expect(f.get("resend")!.enviar).toHaveBeenCalledWith(CORREO, "osefi@osefi.net", {
      plazo_ms: MAIL_PLAZO_POR_INTENTO_MS,
    });
  });

  it("logs who carried it — with the address masked, never in full", async () => {
    cadena({ nombre: "resend" });
    await enviar(CORREO);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ proveedor: "resend", flujo: "mfa/codigo", id: "resend-id", para: "a***@osefi.net" }),
      "correo enviado",
    );
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain("ana@osefi.net");
  });
});

describe("the classification table", () => {
  it("a refused recipient is terminal: no relay, no sideline, no charge", async () => {
    const f = cadena({ nombre: "a", respuestas: [fallo("destinatario")] }, { nombre: "b" });
    const r = await enviar(CORREO);
    expect(r).toEqual({ ok: false, motivo: "destinatario", proveedor: "a" });
    expect(f.get("b")!.enviar).not.toHaveBeenCalled();
    expect(estadoDeLaCadena()[0]).toMatchObject({ apartadoHasta: null, restante: 100 - Math.floor(100 * MAIL_RESERVA_FRACCION) });
  });

  it("a refused message relays, charges, and does not sideline", async () => {
    const f = cadena({ nombre: "a", respuestas: [fallo("contenido")] }, { nombre: "b" });
    const r = await enviar(CORREO);
    expect(r).toEqual({ ok: true, proveedor: "b", id: "b-id" });
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(1);
    const [a] = estadoDeLaCadena();
    expect(a.apartadoHasta).toBeNull();
    expect(a.restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION) - 1);
  });

  it("a 'try later' relays and neither sidelines nor charges", async () => {
    cadena({ nombre: "a", respuestas: [fallo("temporal")] }, { nombre: "b" });
    const r = await enviar(CORREO);
    expect(r).toMatchObject({ ok: true, proveedor: "b" });
    const [a] = estadoDeLaCadena();
    expect(a.apartadoHasta).toBeNull();
    expect(a.restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION));
  });

  it("an outage relays and does not charge; two in a row sideline the provider for the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const f = cadena({ nombre: "a", respuestas: [fallo("averia"), fallo("averia"), fallo("averia")] }, { nombre: "b" });
    await enviar(CORREO);
    expect(estadoDeLaCadena()[0].apartadoHasta).toBeNull();
    await enviar(CORREO);
    expect(estadoDeLaCadena()[0]).toMatchObject({ apartadoHasta: Date.now() + MAIL_PROVIDER_COOLDOWN_MS, motivo: "averia" });
    expect(estadoDeLaCadena()[0].restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION));
    // Sidelined: the third message goes straight to b without asking a.
    await enviar(CORREO);
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(2);
    expect(f.get("b")!.enviar).toHaveBeenCalledTimes(3);
  });

  it("lets one probe through when the cooldown is over, and sidelines again on a failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const f = cadena({ nombre: "a", respuestas: [fallo("averia"), fallo("averia"), fallo("averia")] }, { nombre: "b" });
    await enviar(CORREO);
    await enviar(CORREO);
    vi.advanceTimersByTime(MAIL_PROVIDER_COOLDOWN_MS);
    await enviar(CORREO);
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(3);
    expect(estadoDeLaCadena()[0].apartadoHasta).toBe(Date.now() + MAIL_PROVIDER_COOLDOWN_MS);
  });

  it("a success clears the outage count", async () => {
    const f = cadena({ nombre: "a", respuestas: [fallo("averia"), { ok: true, id: "x" }, fallo("averia")] }, { nombre: "b" });
    await enviar(CORREO);
    await enviar(CORREO);
    await enviar(CORREO);
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(3);
    expect(estadoDeLaCadena()[0].apartadoHasta).toBeNull();
  });

  it("a refused login sidelines the provider until restart, and says which one", async () => {
    cadena({ nombre: "a", respuestas: [fallo("autenticacion")] }, { nombre: "b" });
    const r = await enviar(CORREO);
    expect(r).toMatchObject({ ok: true, proveedor: "b" });
    // Spelled out, not `Infinity`: JSON has no Infinity and pino would write
    // `null`, the value that means "in service".
    expect(estadoDeLaCadena()[0]).toMatchObject({ apartadoHasta: "reinicio", motivo: "autenticacion" });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ proveedor: "a", clase: "autenticacion" }), expect.stringContaining("credenciales"));
  });

  it("a quota answer marks the local budget spent and sidelines until the window rolls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    cadena({ nombre: "a", respuestas: [fallo("cuota")] }, { nombre: "b" });
    await enviar(CORREO);
    expect(estadoDeLaCadena()[0]).toMatchObject({ apartadoHasta: Date.now() + MAIL_DAILY_WINDOW_MS, motivo: "cuota", restante: 0 });
  });

  // 🔴 The decision of design §1.2.3: at most two copies, never a person locked out.
  it("relays on an ambiguous cut, charging the provider that may have delivered", async () => {
    const f = cadena({ nombre: "a", respuestas: [fallo("ambiguo")] }, { nombre: "b" });
    const r = await enviar(CORREO);
    expect(r).toMatchObject({ ok: true, proveedor: "b" });
    expect(f.get("b")!.enviar).toHaveBeenCalledTimes(1);
    expect(estadoDeLaCadena()[0].restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION) - 1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ clase: "ambiguo" }), expect.stringContaining("dos copias"));
  });

  // Audit of Task 7: a first draft reset the breaker on `ambiguo`, so a
  // provider whose socket stalled on every message was never sidelined and
  // was charged one unit per message for sending nothing.
  it("two ambiguous cuts in a row sideline the provider like two outages, and each is still charged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const f = cadena({ nombre: "a", respuestas: [fallo("ambiguo"), fallo("ambiguo"), fallo("ambiguo")] }, { nombre: "b" });
    await enviar(CORREO);
    expect(estadoDeLaCadena()[0].apartadoHasta).toBeNull();
    await enviar(CORREO);
    expect(estadoDeLaCadena()[0]).toMatchObject({ apartadoHasta: Date.now() + MAIL_PROVIDER_COOLDOWN_MS, motivo: "averia" });
    expect(estadoDeLaCadena()[0].restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION) - 2);
    await enviar(CORREO);
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(2);
  });

  // 🔴 The audit's red finding, at the relay's end: a refused *sender* used to
  // be filed as a refused recipient and end the message at that provider.
  it("a refused sender or a missing STARTTLS relays, does not charge, sidelines until restart, and names what to check", async () => {
    cadena({ nombre: "a", respuestas: [fallo("configuracion")] }, { nombre: "b" });
    const r = await enviar(CORREO);
    expect(r).toMatchObject({ ok: true, proveedor: "b" });
    expect(estadoDeLaCadena()[0]).toMatchObject({
      apartadoHasta: "reinicio",
      motivo: "configuracion",
      restante: 100 - Math.floor(100 * MAIL_RESERVA_FRACCION),
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ proveedor: "a", clase: "configuracion" }),
      expect.stringMatching(/remitente/),
    );
  });

  it("a provider that throws is filed as an outage: relayed and not charged", async () => {
    const roto: ProveedorDeCorreo = {
      nombre: "roto",
      enviar: vi.fn(async () => {
        throw new Error("bug en el adaptador");
      }),
    };
    const b = falso("b");
    configurarRelevo(
      { ok: true, modo: "envia", from: "osefi@osefi.net", proveedores: [cfg("roto"), cfg("b")], descartados: [] },
      (c) => (c.nombre === "roto" ? roto : b.proveedor),
    );
    const r = await enviar(CORREO);
    expect(r).toMatchObject({ ok: true, proveedor: "b" });
    expect(estadoDeLaCadena()[0].restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ proveedor: "roto", clase: "averia" }), expect.any(String));
  });
});

describe("budgets and the reserve", () => {
  it("skips a provider whose unreserved share is spent, and comes back to it for a reserved flow", async () => {
    const f = cadena({ nombre: "a", cupo: 4 }, { nombre: "b" });
    // 4 * 0.25 = 1 reserved: three unreserved sends fit.
    for (let i = 0; i < 3; i++) await enviar(VERIFICACION);
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(3);
    await enviar(VERIFICACION);
    expect(f.get("b")!.enviar).toHaveBeenCalledTimes(1);
    await enviar(CORREO);
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(4);
  });

  it("charges only the provider that carried the message", async () => {
    cadena({ nombre: "a", respuestas: [fallo("averia")] }, { nombre: "b" });
    await enviar(CORREO);
    const [a, b] = estadoDeLaCadena();
    expect(a.restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION));
    expect(b.restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION) - 1);
  });
});

describe("hayProveedorDisponible — the same predicate as the loop's first step", () => {
  it("is false when every provider is sidelined, even with every budget full", async () => {
    cadena({ nombre: "a", respuestas: [fallo("autenticacion")] }, { nombre: "b", respuestas: [fallo("autenticacion")] });
    await enviar(CORREO);
    expect(hayProveedorDisponible("mfa/codigo")).toBe(false);
  });

  it("is false for an unreserved flow once only the reserve is left, and true for a reserved one", async () => {
    cadena({ nombre: "a", cupo: 4 });
    for (let i = 0; i < 3; i++) await enviar(VERIFICACION);
    expect(hayProveedorDisponible("email/verificar")).toBe(false);
    expect(hayProveedorDisponible("mfa/codigo")).toBe(true);
  });

  it("is true in development mode, where nothing is sent and nothing protected", () => {
    configurarRelevo({ ok: true, modo: "desarrollo", from: null, proveedores: [], descartados: [] });
    expect(hayProveedorDisponible("email/verificar")).toBe(true);
  });

  it("spends nothing, however often it is asked", async () => {
    cadena({ nombre: "a", cupo: 4 });
    for (let i = 0; i < 50; i++) hayProveedorDisponible("email/verificar");
    expect(estadoDeLaCadena()[0].restante).toBe(3);
  });
});

describe("when nothing can go out", () => {
  it("answers sin-proveedor with one error line carrying the whole chain, calling nobody that is sidelined", async () => {
    const f = cadena({ nombre: "a", respuestas: [fallo("autenticacion")] }, { nombre: "b", respuestas: [fallo("autenticacion")] });
    await enviar(CORREO);
    error.mockClear();
    const r = await enviar(CORREO);
    expect(r).toEqual({ ok: false, motivo: "sin-proveedor" });
    expect(f.get("a")!.enviar).toHaveBeenCalledTimes(1);
    expect(f.get("b")!.enviar).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({ cadena: [expect.objectContaining({ proveedor: "a" }), expect.objectContaining({ proveedor: "b" })] });
  });

  it("stops walking when the chain's deadline is spent", async () => {
    vi.useFakeTimers();
    const lento: ProveedorDeCorreo = {
      nombre: "lento",
      enviar: vi.fn(async () => {
        vi.advanceTimersByTime(5_000);
        return fallo("averia");
      }),
    };
    const rapido = falso("rapido");
    configurarRelevo(
      {
        ok: true,
        modo: "envia",
        from: "osefi@osefi.net",
        proveedores: [
          { tipo: "smtp", nombre: "lento", host: "h", puerto: 587, usuarioVar: "U", passVar: "P", cupoDiario: 100, cabeceras: {} },
          { tipo: "smtp", nombre: "rapido", host: "h", puerto: 587, usuarioVar: "U", passVar: "P", cupoDiario: 100, cabeceras: {} },
        ],
        descartados: [],
      },
      (cfg) => (cfg.nombre === "lento" ? lento : rapido.proveedor),
    );
    const r = await enviar(CORREO, { plazo_ms: 4_000 });
    expect(r).toEqual({ ok: false, motivo: "plazo" });
    expect(rapido.enviar).not.toHaveBeenCalled();
  });

  // Audit of Task 7: with twelve seconds for the walk and ten per attempt,
  // the second provider used to get two — less than a connection — and was
  // charged an ambiguous attempt that could not have sent anything.
  it("does not start an attempt with less than a connection's worth of time left", async () => {
    vi.useFakeTimers();
    const lento: ProveedorDeCorreo = {
      nombre: "lento",
      enviar: vi.fn(async () => {
        vi.advanceTimersByTime(6_000);
        return fallo("averia");
      }),
    };
    const rapido = falso("rapido");
    configurarRelevo(
      { ok: true, modo: "envia", from: "osefi@osefi.net", proveedores: [cfg("lento"), cfg("rapido")], descartados: [] },
      (c) => (c.nombre === "lento" ? lento : rapido.proveedor),
    );
    const r = await enviar(CORREO, { plazo_ms: 9_000 });
    expect(r).toEqual({ ok: false, motivo: "plazo" });
    expect(rapido.enviar).not.toHaveBeenCalled();
    expect(estadoDeLaCadena()[1].restante).toBe(100 - Math.floor(100 * MAIL_RESERVA_FRACCION));
  });

  it("answers desarrollo, sending nothing, when no chain is configured", async () => {
    configurarRelevo({ ok: true, modo: "desarrollo", from: null, proveedores: [], descartados: [] });
    expect(await enviar(CORREO)).toEqual({ ok: false, motivo: "desarrollo" });
  });
});
