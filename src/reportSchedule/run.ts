// What happens when a scheduled report is due — the whole of it, with every
// outside thing it touches handed in. Design §3.4–§3.7.
//
// **Nothing here reaches the database, the exporter or the mail chain by
// itself.** They arrive as `Dependencias`, which is what lets the rules below
// be tested as rules: who receives which variant, what counts as a failure,
// when a schedule pauses. `store.ts` is the real implementation.
//
// The order of a run, and why it is this order:
//
// 1. **Is the schedule still allowed to run?** The report may have been
//    archived, the owner may be gone or may have lost the permission, the
//    recipients may all have unsubscribed. Any of those pauses it, with the
//    reason, before anything is claimed.
// 2. **Is the exporter free?** There is one export slot for the whole
//    process and a person at a screen may be holding it. Asked before the
//    claim, because a claim cannot be taken back cleanly: the run simply
//    waits for the next tick.
// 3. **Claim the run.** Inserting the execution row is the lock (see the
//    migration). Losing the race is not an error; it means somebody else has
//    this run.
// 4. **Build the files, all of them, before sending any.** At most two — see
//    `variantes`. If one cannot be built nobody receives anything: half the
//    recipients holding a report the other half never got is worse than a
//    late report.
// 5. **Send, recipient by recipient**, inside the day's ceiling.
// 6. **Close the run and schedule the next one.** Always, including when
//    step 4 or 5 threw: a run left `en_curso` would read as "still sending"
//    for ever.

import { MAIL_ADJUNTOS_MAX_BYTES } from "../config/security.js";
import type { CorreoAEnviar, ResultadoDeCorreo } from "../auth/mailer.js";
import type { ExportFormat, ExportOutput } from "../reportBuilder/export/index.js";
import type { ReportConfig } from "../reportBuilder/types.js";
import type { Viewer } from "../reportBuilder/viewer.js";
import {
  FALLOS_PARA_PAUSAR,
  MAX_CORREOS_DE_INFORMES_AL_DIA,
  PLAZO_DE_ENVIO_MS,
  RECHAZOS_PARA_DEJAR,
} from "./limits.js";
import {
  mensajeConInforme,
  mensajeDeFalloAlDueno,
  mensajeDemasiadoGrande,
  mensajeVacio,
  type DatosDelMensaje,
  type Mensaje,
} from "./messages.js";
import { proximaEjecucion, type Horario } from "./nextRun.js";

export type MotivoDePausa =
  | "manual"
  | "fallos"
  | "sin_permiso"
  | "dueno_inactivo"
  | "informe_archivado"
  | "sin_destinatarios";

export type EstadoFinal = "enviado" | "vacio" | "demasiado_grande" | "fallido";

export interface Programacion extends Horario {
  id: number;
  id_reporte: number;
  id_usuario: number;
  formato: ExportFormat;
  con_fotos: boolean;
  fallos_seguidos: number;
}

export interface Destinatario {
  id: number;
  /** Where the message goes: the user's verified address, or the outside one. */
  email: string;
  /** No account: never receives staff data, and gets an unsubscribe link. */
  externo: boolean;
  /** Whether this recipient may see other people's personal data on screen. */
  staff: boolean;
  rechazos_seguidos: number;
  /** Unsubscribed. Only an outside address can be. */
  deBaja: boolean;
}

export interface Contexto {
  /** `null` when the saved report was archived or no longer exists. */
  informe: { nombre: string; config: ReportConfig } | null;
  /** `null` when the owner's account is gone or disabled. */
  dueno: {
    nombre: string;
    /** Verified address for failure notices; `null` if they have none. */
    email: string | null;
    role: number;
    staff: boolean;
    puedeProgramar: boolean;
  } | null;
  destinatarios: Destinatario[];
}

export interface CierreDeEjecucion {
  estado: EstadoFinal;
  filas: number | null;
  bytes: number | null;
  enviados: number;
  no_enviados: number;
  detalle: string | null;
}

export interface Dependencias {
  ahora(): Date;
  cargarContexto(p: Programacion): Promise<Contexto>;
  /** The saved configuration cut down to what this viewer may read. */
  podar(config: ReportConfig, viewer: Viewer): ReportConfig;
  exportadorOcupado(): boolean;
  /** Throws `ExportBusyError` if the slot was taken in the meantime. */
  exportar(peticion: {
    config: ReportConfig;
    viewer: Viewer;
    format: ExportFormat;
    title: string;
    photos: boolean;
  }): Promise<ExportOutput>;
  /** The execution's id, or `null` if this run is already claimed. */
  reclamar(id_programacion: number, turno: Date, manual: boolean): Promise<number | null>;
  /** Undo a claim that turned out not to be usable — the slot was taken. */
  liberar(id_ejecucion: number): Promise<void>;
  cerrar(id_ejecucion: number, cierre: CierreDeEjecucion): Promise<void>;
  /** Report messages already sent in the last twenty-four hours. */
  enviadosHoy(): Promise<number>;
  enviar(correo: CorreoAEnviar, opciones: { plazo_ms: number }): Promise<ResultadoDeCorreo>;
  anotarEntrega(id_destinatario: number, resultado: "entregado" | "rechazado"): Promise<void>;
  enlaceDeBaja(id_destinatario: number): Promise<string | null>;
  reprogramar(
    id_programacion: number,
    cambios: { proxima_ejecucion: Date | null; fallos_seguidos: number; activa: boolean; motivo_pausa: MotivoDePausa | null },
  ): Promise<void>;
  registrar(nivel: "info" | "warn" | "error", datos: Record<string, unknown>, mensaje: string): void;
}

export type ResultadoDelTurno =
  | { tipo: "ejecutado"; estado: EstadoFinal; enviados: number; no_enviados: number }
  | { tipo: "pausada"; motivo: MotivoDePausa }
  | { tipo: "ocupado" }
  | { tipo: "ya_reclamado" };

const esExportadorOcupado = (e: unknown): boolean => (e as Error | undefined)?.name === "ExportBusyError";
const esDemasiadoGrande = (e: unknown): boolean =>
  ["ExportTooLargeError", "ExportTooHeavyError"].includes((e as Error | undefined)?.name ?? "");

/** Recipients a message may still be sent to. */
export const destinatariosActivos = (todos: Destinatario[]): Destinatario[] =>
  todos.filter((d) => !d.deBaja && d.rechazos_seguidos < RECHAZOS_PARA_DEJAR);

/**
 * Whether this recipient gets the variant that includes staff data.
 *
 * Only when they could see it on screen themselves **and** the owner can too:
 * nobody receives by mail more than they would be shown, nor more than the
 * person who set the schedule up is allowed to hand out. An outside address
 * never does, whatever else is true.
 */
export const recibeDatosDePersonal = (d: Destinatario, dueno: { staff: boolean }): boolean =>
  !d.externo && d.staff && dueno.staff;

/** What one variant of the report turned out to be. */
type Variante =
  | { tipo: "fichero"; salida: ExportOutput }
  | { tipo: "vacio" }
  | { tipo: "demasiado_grande"; filas: number | null };

function contenido(
  v: Variante,
  d: DatosDelMensaje,
  fichero: { formato: ExportFormat; generado: Date },
): { mensaje: Mensaje; adjunto: ExportOutput | null } {
  if (v.tipo === "fichero") {
    return {
      mensaje: mensajeConInforme(d, {
        filas: v.salida.rows,
        nombreDelFichero: v.salida.filename,
        bytes: v.salida.buffer.length,
        ...fichero,
      }),
      adjunto: v.salida,
    };
  }
  if (v.tipo === "vacio") return { mensaje: mensajeVacio(d), adjunto: null };
  return { mensaje: mensajeDemasiadoGrande(d, { filas: v.filas }), adjunto: null };
}

/**
 * Run one schedule for one due moment.
 *
 * `manual` is "send it now", pressed by a person to try a schedule out: the
 * run is recorded like any other but leaves the schedule's own state — its
 * next run, its count of failures — exactly as it was.
 */
export async function ejecutarTurno(
  deps: Dependencias,
  p: Programacion,
  turno: Date,
  opciones: { manual?: boolean } = {},
): Promise<ResultadoDelTurno> {
  const manual = opciones.manual === true;
  const ctx = await deps.cargarContexto(p);
  const activos = destinatariosActivos(ctx.destinatarios);

  const motivo: MotivoDePausa | null = !ctx.informe
    ? "informe_archivado"
    : !ctx.dueno
      ? "dueno_inactivo"
      : !ctx.dueno.puedeProgramar
        ? "sin_permiso"
        : activos.length === 0
          ? "sin_destinatarios"
          : null;
  if (motivo || !ctx.informe || !ctx.dueno) {
    const porQue = motivo ?? "informe_archivado";
    await deps.reprogramar(p.id, {
      proxima_ejecucion: null,
      fallos_seguidos: p.fallos_seguidos,
      activa: false,
      motivo_pausa: porQue,
    });
    deps.registrar("warn", { id_programacion: p.id, motivo: porQue }, "informe programado en pausa: ya no puede ejecutarse");
    return { tipo: "pausada", motivo: porQue };
  }
  const { informe, dueno } = ctx;

  if (deps.exportadorOcupado()) return { tipo: "ocupado" };

  const id_ejecucion = await deps.reclamar(p.id, turno, manual);
  if (id_ejecucion === null) {
    // Somebody else has this run — or had it and died. Either way the
    // schedule must move on, or it would be found due on every tick for ever.
    if (!manual) {
      await deps.reprogramar(p.id, {
        proxima_ejecucion: proximaEjecucion(p, deps.ahora()),
        fallos_seguidos: p.fallos_seguidos,
        activa: true,
        motivo_pausa: null,
      });
    }
    return { tipo: "ya_reclamado" };
  }

  let cierre: CierreDeEjecucion = {
    estado: "fallido",
    filas: null,
    bytes: null,
    enviados: 0,
    no_enviados: 0,
    detalle: null,
  };
  let liberada = false;

  try {
    // ── The files: one per kind of reader, at most two. ──────────────────
    const variantes = new Map<boolean, Variante>();
    for (const conPersonal of [...new Set(activos.map((d) => recibeDatosDePersonal(d, dueno)))]) {
      const viewer: Viewer = { role: dueno.role, staff: conPersonal };
      try {
        const salida = await deps.exportar({
          config: deps.podar(informe.config, viewer),
          viewer,
          format: p.formato,
          title: informe.nombre,
          photos: p.con_fotos,
        });
        variantes.set(
          conPersonal,
          salida.rows === 0
            ? { tipo: "vacio" }
            : salida.buffer.length > MAIL_ADJUNTOS_MAX_BYTES
              ? { tipo: "demasiado_grande", filas: salida.rows }
              : { tipo: "fichero", salida },
        );
      } catch (e) {
        if (esDemasiadoGrande(e)) {
          // `ExportTooLargeError` knows how many rows there were;
          // `ExportTooHeavyError` weighed a finished file and only knows bytes.
          const filas = (e as { rows?: unknown }).rows;
          variantes.set(conPersonal, { tipo: "demasiado_grande", filas: typeof filas === "number" ? filas : null });
          continue;
        }
        throw e;
      }
    }

    // One moment for every copy: the files were all built just now.
    const generado = deps.ahora();

    // ── The sends, inside what is left of the day's ceiling. ─────────────
    let quedan = Math.max(0, MAX_CORREOS_DE_INFORMES_AL_DIA - (await deps.enviadosHoy()));
    let sinCupo = 0;
    for (const d of activos) {
      if (quedan === 0) {
        sinCupo += 1;
        cierre.no_enviados += 1;
        continue;
      }
      const variante = variantes.get(recibeDatosDePersonal(d, dueno)) as Variante;
      const { mensaje, adjunto } = contenido(variante, {
        informe: informe.nombre,
        programadoPor: dueno.nombre,
        horario: p,
        externo: d.externo,
        enlaceDeBaja: d.externo ? await deps.enlaceDeBaja(d.id) : null,
      }, { formato: p.formato, generado });
      const r = await deps.enviar(
        {
          para: d.email,
          flujo: "informe/programado",
          asunto: mensaje.asunto,
          html: mensaje.html,
          texto: mensaje.texto,
          ...(adjunto
            ? { adjuntos: [{ nombre: adjunto.filename, tipo: adjunto.contentType, contenido: adjunto.buffer }] }
            : {}),
        },
        { plazo_ms: PLAZO_DE_ENVIO_MS },
      );
      if (r.ok) {
        cierre.enviados += 1;
        quedan -= 1;
        await deps.anotarEntrega(d.id, "entregado");
      } else {
        cierre.no_enviados += 1;
        // Only a refusal of the address itself counts against it. A chain
        // that was down says nothing about whether the address is good.
        if (r.motivo === "destinatario") await deps.anotarEntrega(d.id, "rechazado");
      }
    }

    // What the run "was" is what its widest audience got: the variant
    // without staff data when there is one, since every outside address and
    // most accounts receive that one.
    const principal = (variantes.get(false) ?? variantes.get(true)) as Variante;
    const fichero = principal.tipo === "fichero" ? principal.salida : null;
    cierre = {
      ...cierre,
      estado: cierre.enviados === 0 ? "fallido" : principal.tipo === "fichero" ? "enviado" : principal.tipo,
      filas: fichero ? fichero.rows : principal.tipo === "demasiado_grande" ? principal.filas : 0,
      bytes: fichero ? fichero.buffer.length : null,
      detalle:
        cierre.enviados === 0
          ? sinCupo === activos.length
            ? "Se alcanzó el tope diario de correos de informes."
            : "No se pudo entregar a ningún destinatario."
          : sinCupo > 0
            ? `${sinCupo} sin enviar por el tope diario de correos de informes.`
            : null,
    };
  } catch (e) {
    if (esExportadorOcupado(e)) {
      // The slot was free a moment ago and is not now. Give the run back.
      await deps.liberar(id_ejecucion);
      liberada = true;
    } else {
      cierre = { ...cierre, estado: "fallido", detalle: `Error durante la ejecución: ${(e as Error)?.message ?? String(e)}`.slice(0, 300) };
      deps.registrar("error", { id_programacion: p.id, err: e }, "informe programado: falló la ejecución");
    }
  }

  if (liberada) return { tipo: "ocupado" };

  await deps.cerrar(id_ejecucion, cierre);

  if (!manual) {
    const fallos = cierre.estado === "fallido" ? p.fallos_seguidos + 1 : 0;
    const pausar = fallos >= FALLOS_PARA_PAUSAR;
    await deps.reprogramar(p.id, {
      proxima_ejecucion: pausar ? null : proximaEjecucion(p, deps.ahora()),
      fallos_seguidos: fallos,
      activa: !pausar,
      motivo_pausa: pausar ? "fallos" : null,
    });
    if (cierre.estado === "fallido" && dueno.email) {
      const aviso = mensajeDeFalloAlDueno({
        informe: informe.nombre,
        motivo: cierre.detalle ?? "Error desconocido.",
        pausada: pausar,
        fallosSeguidos: fallos,
      });
      // Best effort: if the chain is what failed, this will not arrive
      // either, and the history row is what remains.
      await deps
        .enviar({ para: dueno.email, flujo: "informe/programado", ...aviso }, { plazo_ms: PLAZO_DE_ENVIO_MS })
        .catch(() => undefined);
    }
  }

  deps.registrar(
    cierre.estado === "fallido" ? "error" : "info",
    { id_programacion: p.id, id_ejecucion, estado: cierre.estado, enviados: cierre.enviados, no_enviados: cierre.no_enviados, manual },
    "informe programado ejecutado",
  );
  return { tipo: "ejecutado", estado: cierre.estado, enviados: cierre.enviados, no_enviados: cierre.no_enviados };
}
