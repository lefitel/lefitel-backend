// The chain of providers behind `enviarCorreo` — plan 4E, Task 7; design §4.
//
// Fixed order, one budget per provider with a reserved share for the login
// code and the security notices, every failure classified, a circuit breaker
// per provider, and a deadline for the whole walk. A message leaves by the
// first provider that accepts it.
//
// **What "accepts" means, and the one case where a message may go out twice.**
// The relay moves to the next provider when the current one *refused* the
// message or was unreachable. When the connection died after the body was
// sent and before the acknowledgement, nobody can know whether it was
// delivered; the relay relays anyway (design §1.2.3, Isaias 2026-09-03),
// because every payload this system sends is harmless in duplicate — a code
// row, a single-use link, a notice — and a person who cannot log in is not.
// The guarantee is "at most one code, at most two copies".
//
// **What is charged.** Only what the provider itself counts: attempts that
// reached `DATA`, and the ambiguous ones. A refused address, a dead DNS, a
// closed port 587 or a wrong password move nobody's counter; charging them
// would let a firewall eat four daily quotas in silence.
//
// **The breaker.** Two outage-shaped failures in a row sideline a provider
// for `MAIL_PROVIDER_COOLDOWN_MS`; when that passes, the next message is the
// probe — one attempt, and a failure sidelines it again. An ambiguous cut
// counts as outage-shaped too: a socket that stalls after `DATA` on every
// message is a provider that is down, however each attempt is filed, and a
// first draft that reset the counter on `ambiguo` could never sideline it
// (audit of Task 7). A refused login (535) sidelines until restart: fifteen
// minutes change nothing about a wrong password, and an `error` line names
// the variable to fix; a refused sender or a missing STARTTLS
// (`configuracion`) likewise, naming what to check in the provider's panel.
// A quota answer marks the local budget spent and sidelines until the window
// rolls — and only a real quota does: a per-second rate limit is `temporal`.
//
// **The clock.** `plazo_ms` bounds the whole walk; each attempt gets at most
// `MAIL_PLAZO_POR_INTENTO_MS` of what is left, and no attempt starts with
// less than `MAIL_PLAZO_MINIMO_INTENTO_MS` — an attempt that cannot even
// connect and be greeted sends nothing and would be charged as ambiguous.
// Sidelined and exhausted providers are skipped before the clock is read:
// they cost no time, so four sidelined providers never hide a live fifth.
//
// **`hayProveedorDisponible` is the first step of the loop, exported.** It is
// what a controller asks before doing something destructive — burning the
// pending verification link, burning the pending login code — and it has to
// be literally the same predicate the loop uses, quota **and** breaker: a
// first draft answered "some provider has quota" without looking at the
// breaker, and with all five sidelined and every budget full it would have
// let `/email/send` wipe a verified address to send nothing.
//
// **Configured once, lazily.** `index.ts` configures the chain at boot from
// `configuracionDeCorreo`; a process that never did — the rescue console, a
// script — gets the same configuration on first use. Nothing here reads a
// secret: the providers read theirs by variable name at send time.

import {
  configuracionDeCorreo,
  MAIL_PLAZO_DIFERIDO_MS,
  MAIL_PLAZO_MINIMO_INTENTO_MS,
  MAIL_PLAZO_POR_INTENTO_MS,
  MAIL_PROVIDER_COOLDOWN_MS,
  MAIL_DAILY_WINDOW_MS,
  type ConfiguracionDeCorreo,
  type ProveedorConfigurado,
} from "../config/security.js";
import { crearPresupuesto, type Presupuesto } from "./mailBudget.js";
import {
  resendProvider,
  smtpProvider,
  type ProveedorDeCorreo,
  type FabricaDeTransporte,
  type ResultadoEnvio,
} from "./mailProviders.js";
import type { CorreoAEnviar, FlujoDeCorreo } from "./mailer.js";
import { maskEmail } from "./maskEmail.js";
import { log } from "../utils/logger.js";

const relayLog = log("mailRelay");

/**
 * Why nothing went out, when nothing did. `"error"` is `mailer.ts`'s only:
 * the relay itself threw, which is a bug here and not a state of the chain.
 */
export type MotivoDeRelevo = "desarrollo" | "destinatario" | "sin-proveedor" | "plazo" | "error";

export type ResultadoRelevo =
  | { ok: true; proveedor: string; id: string | null; motivo?: undefined }
  | { ok: false; motivo: MotivoDeRelevo; proveedor?: string };

interface EstadoDeProveedor {
  proveedor: ProveedorDeCorreo;
  presupuesto: Presupuesto;
  averiasSeguidas: number;
  /** `null` while in service; an instant while sidelined; `Infinity` until restart. */
  apartadoHasta: number | null;
  motivoApartado: string | null;
}

/** How each provider is built from its configuration — injectable so the relay's tests use fakes. */
export type FabricaDeProveedores = (cfg: ProveedorConfigurado) => ProveedorDeCorreo;

export function fabricaDeProveedoresReal(fabricaSmtp?: FabricaDeTransporte): FabricaDeProveedores {
  return (cfg) => (cfg.tipo === "resend" ? resendProvider(cfg.claveVar) : smtpProvider(cfg, fabricaSmtp));
}

let cadena: EstadoDeProveedor[] | null = null;
let modo: "envia" | "desarrollo" = "desarrollo";
let from: string | null = null;

/**
 * Install the chain. Called by `index.ts` at boot and by `asegurarConfigurado`
 * on first use; calling it again replaces the chain and its counters.
 */
export function configurarRelevo(
  config: ConfiguracionDeCorreo,
  fabrica: FabricaDeProveedores = fabricaDeProveedoresReal(),
): void {
  if (!config.ok) {
    cadena = [];
    modo = "desarrollo";
    from = null;
    return;
  }
  modo = config.modo;
  from = config.from;
  cadena = config.proveedores.map((cfg) => ({
    proveedor: fabrica(cfg),
    presupuesto: crearPresupuesto(cfg.nombre, cfg.cupoDiario),
    averiasSeguidas: 0,
    apartadoHasta: null,
    motivoApartado: null,
  }));
}

/** For tests: back to "never configured". */
export function reiniciarRelevo(): void {
  cadena = null;
  modo = "desarrollo";
  from = null;
}

function asegurarConfigurado(): EstadoDeProveedor[] {
  if (cadena === null) configurarRelevo(configuracionDeCorreo(process.env, process.env.NODE_ENV));
  return cadena as EstadoDeProveedor[];
}

function enServicio(e: EstadoDeProveedor, ahora: number): boolean {
  return e.apartadoHasta === null || ahora >= e.apartadoHasta;
}

function disponible(e: EstadoDeProveedor, flujo: FlujoDeCorreo, ahora: number): boolean {
  return enServicio(e, ahora) && e.presupuesto.hay(flujo);
}

/**
 * Whether some provider could send a message of this flow right now: in
 * service (not sidelined) **and** with budget for the flow. In development
 * mode — no chain configured — always `true`: nothing is sent and nothing is
 * spent, so there is nothing to protect by refusing.
 */
export function hayProveedorDisponible(flujo: FlujoDeCorreo): boolean {
  const lista = asegurarConfigurado();
  if (modo === "desarrollo") return true;
  const ahora = Date.now();
  return lista.some((e) => disponible(e, flujo, ahora));
}

/**
 * The chain's state, for the exhaustion line and for tests. "Until restart"
 * is spelled out: JSON has no `Infinity`, and pino would write `null` — the
 * value that means "in service".
 */
export function estadoDeLaCadena(): {
  proveedor: string;
  apartadoHasta: number | "reinicio" | null;
  motivo: string | null;
  restante: number;
}[] {
  return asegurarConfigurado().map((e) => ({
    proveedor: e.proveedor.nombre,
    apartadoHasta: e.apartadoHasta === Infinity ? "reinicio" : e.apartadoHasta,
    motivo: e.motivoApartado,
    restante: e.presupuesto.restante(),
  }));
}

function apartar(e: EstadoDeProveedor, hasta: number, motivo: string): void {
  e.apartadoHasta = hasta;
  e.motivoApartado = motivo;
}

/**
 * Walk the chain. `plazo_ms` bounds the whole walk — the interactive flows
 * pass twelve seconds, the detached ones sixty (`MAIL_PLAZO_DIFERIDO_MS`);
 * each attempt gets at most `MAIL_PLAZO_POR_INTENTO_MS` of what is left.
 */
export async function enviar(
  correo: CorreoAEnviar,
  opciones: { plazo_ms?: number } = {},
): Promise<ResultadoRelevo> {
  const lista = asegurarConfigurado();
  // Masked in every line this function writes: a `"correo enviado"` line for
  // `password/forgot` is otherwise a durable record of who asked for a reset.
  const para = maskEmail(correo.para);
  if (modo === "desarrollo" || from === null) {
    relayLog.warn(
      { para, asunto: correo.asunto, flujo: correo.flujo },
      "correo NO enviado: sin cadena de proveedores configurada (modo desarrollo)",
    );
    return { ok: false, motivo: "desarrollo" };
  }

  const plazoTotal = opciones.plazo_ms ?? MAIL_PLAZO_DIFERIDO_MS;
  const inicio = Date.now();
  let intento = 0;

  for (const e of lista) {
    // Skipped providers cost no time, so they go before the clock.
    if (!enServicio(e, Date.now())) continue;
    if (!e.presupuesto.hay(correo.flujo)) continue;

    const restante = plazoTotal - (Date.now() - inicio);
    if (restante < MAIL_PLAZO_MINIMO_INTENTO_MS) {
      relayLog.error(
        { flujo: correo.flujo, para, plazo_ms: plazoTotal, restante_ms: restante, cadena: estadoDeLaCadena() },
        "correo NO enviado: se agotó el plazo de la cadena antes de probar todos los proveedores",
      );
      return { ok: false, motivo: "plazo" };
    }

    intento += 1;
    const empezo = Date.now();
    let r: ResultadoEnvio;
    try {
      r = await e.proveedor.enviar(correo, from, { plazo_ms: Math.min(MAIL_PLAZO_POR_INTENTO_MS, restante) });
    } catch (err) {
      // Both adapters catch their own failures; a throw here is a bug in one
      // of them, and it must not take the login down with it. Filed as an
      // outage: relay, no charge, breaker.
      r = { ok: false, clase: "averia", detalle: `excepción: ${(err as Error | undefined)?.message ?? String(err)}` };
    }
    const ms = Date.now() - empezo;
    const base = { flujo: correo.flujo, para, proveedor: e.proveedor.nombre, intento, ms };

    if (r.ok) {
      e.averiasSeguidas = 0;
      e.apartadoHasta = null;
      e.motivoApartado = null;
      e.presupuesto.consumir(correo.flujo);
      relayLog.info({ ...base, id: r.id }, "correo enviado");
      return { ok: true, proveedor: e.proveedor.nombre, id: r.id };
    }

    const fallo = { ...base, clase: r.clase, detalle: r.detalle };
    switch (r.clase) {
      case "destinatario":
        // Terminal for this message, harmless to the provider.
        relayLog.warn(fallo, "correo NO enviado: el proveedor rechazó al destinatario");
        return { ok: false, motivo: "destinatario", proveedor: e.proveedor.nombre };
      case "contenido":
        e.averiasSeguidas = 0;
        e.presupuesto.consumir(correo.flujo);
        relayLog.error(fallo, "el proveedor rechazó el mensaje; se releva al siguiente");
        continue;
      case "temporal":
        e.averiasSeguidas = 0;
        relayLog.warn(fallo, "el proveedor pidió reintentar más tarde; se releva al siguiente");
        continue;
      case "averia":
        e.averiasSeguidas += 1;
        if (e.averiasSeguidas >= 2) {
          apartar(e, Date.now() + MAIL_PROVIDER_COOLDOWN_MS, "averia");
        }
        relayLog.error({ ...fallo, averias_seguidas: e.averiasSeguidas, apartado_hasta: e.apartadoHasta }, "proveedor inalcanzable; se releva al siguiente");
        continue;
      case "autenticacion":
        apartar(e, Infinity, "autenticacion");
        relayLog.error(
          { ...fallo, apartado_hasta: "reinicio" },
          "el proveedor rechazó las credenciales: apartado hasta reiniciar. Revisa sus variables de entorno",
        );
        continue;
      case "cuota":
        e.presupuesto.agotar();
        apartar(e, Date.now() + MAIL_DAILY_WINDOW_MS, "cuota");
        relayLog.error(fallo, "el proveedor dice que su cuota está agotada: apartado hasta que ruede la ventana");
        continue;
      case "configuracion":
        apartar(e, Infinity, "configuracion");
        relayLog.error(
          { ...fallo, apartado_hasta: "reinicio" },
          "el proveedor rechaza nuestro remitente o nuestra conexión: apartado hasta reiniciar. Revisa en su panel el dominio remitente y el puerto/STARTTLS",
        );
        continue;
      case "ambiguo":
        // Charged, because it may have gone out; and counted against the
        // breaker, because a socket that stalls on every message is a
        // provider that is down, however each attempt has to be filed.
        e.averiasSeguidas += 1;
        if (e.averiasSeguidas >= 2) {
          apartar(e, Date.now() + MAIL_PROVIDER_COOLDOWN_MS, "averia");
        }
        e.presupuesto.consumir(correo.flujo);
        relayLog.warn(
          { ...fallo, averias_seguidas: e.averiasSeguidas, apartado_hasta: e.apartadoHasta },
          "el proveedor cortó sin confirmar: puede haber entregado; se releva al siguiente (a lo sumo dos copias)",
        );
        continue;
    }
  }

  relayLog.error(
    { flujo: correo.flujo, para, intentos: intento, cadena: estadoDeLaCadena() },
    "correo NO enviado: ningún proveedor disponible pudo entregarlo",
  );
  return { ok: false, motivo: "sin-proveedor" };
}
