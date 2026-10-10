// The tick: once a minute, find the schedules that are due and run them.
// Design §3.4. Like `run.ts`, everything outside arrives as a dependency.
//
// **One at a time, in the order they were due.** There is a single export
// slot in the process, so running two at once would only make the second
// one wait or fail. And when the slot turns out to be busy — a person is
// exporting from the screen — the tick stops there: every schedule after it
// would find the same thing.
//
// **A run that is too late is not sent.** The server was down at seven; it is
// back at nine, and the seven o'clock report goes out. It was down since
// Friday; it is back on Monday, and Friday's and Saturday's reports are
// recorded as `omitido` rather than delivered as if they were news.
//
// **One tick never overlaps the next.** A run can take minutes; the interval
// is one. A tick that finds the previous one still working does nothing.
//
// **Nothing here may reject.** `index.ts` treats a promise rejected with
// nobody holding it as fatal and ends the process — the same reason
// `auth/purgeJob.ts` catches at the call. A schedule that throws is logged and
// the next one still runs.

import { EJECUCION_ABANDONADA_MS, RETRASO_MAXIMO_MS } from "./limits.js";
import { proximaEjecucion } from "./nextRun.js";
import type { Programacion, ResultadoDelTurno } from "./run.js";

export interface Vencida {
  programacion: Programacion;
  /** The moment it was due — the schedule's stored next run. */
  turno: Date;
}

export interface DependenciasDelProgramador {
  ahora(): Date;
  /** Active schedules whose next run is not after `ahora`, earliest first. */
  vencidas(ahora: Date): Promise<Vencida[]>;
  ejecutar(p: Programacion, turno: Date): Promise<ResultadoDelTurno>;
  /** Record a run that was due and will not be sent, and move the schedule on. */
  omitir(p: Programacion, turno: Date, proxima: Date): Promise<void>;
  /** Close runs claimed before `antesDe` and never finished. Returns how many. */
  cerrarAbandonadas(antesDe: Date): Promise<number>;
  registrar(nivel: "info" | "warn" | "error", datos: Record<string, unknown>, mensaje: string): void;
}

export interface ResumenDelTic {
  ejecutadas: number;
  omitidas: number;
  /** True when the tick stopped because the export slot was taken. */
  ocupado: boolean;
  errores: number;
}

/** One pass. Resolves always; see the header. */
export async function tic(deps: DependenciasDelProgramador): Promise<ResumenDelTic> {
  const resumen: ResumenDelTic = { ejecutadas: 0, omitidas: 0, ocupado: false, errores: 0 };
  const ahora = deps.ahora();

  try {
    const cerradas = await deps.cerrarAbandonadas(new Date(ahora.getTime() - EJECUCION_ABANDONADA_MS));
    if (cerradas > 0) {
      deps.registrar("warn", { cerradas }, "informes programados: ejecuciones abandonadas cerradas como fallidas");
    }
  } catch (err) {
    resumen.errores += 1;
    deps.registrar("error", { err }, "informes programados: no se pudieron cerrar las ejecuciones abandonadas");
  }

  let vencidas: Vencida[];
  try {
    vencidas = await deps.vencidas(ahora);
  } catch (err) {
    resumen.errores += 1;
    deps.registrar("error", { err }, "informes programados: no se pudo leer qué toca");
    return resumen;
  }

  for (const { programacion, turno } of vencidas) {
    try {
      if (ahora.getTime() - turno.getTime() > RETRASO_MAXIMO_MS) {
        await deps.omitir(programacion, turno, proximaEjecucion(programacion, ahora));
        resumen.omitidas += 1;
        deps.registrar(
          "warn",
          { id_programacion: programacion.id, turno },
          "informe programado omitido: tocaba hace más de lo que se recupera",
        );
        continue;
      }
      const r = await deps.ejecutar(programacion, turno);
      if (r.tipo === "ocupado") {
        resumen.ocupado = true;
        break;
      }
      if (r.tipo === "ejecutado") resumen.ejecutadas += 1;
    } catch (err) {
      resumen.errores += 1;
      deps.registrar("error", { id_programacion: programacion.id, err }, "informe programado: el turno lanzó una excepción");
    }
  }
  return resumen;
}

/**
 * Starts the scheduler: one pass now, then one every `intervaloMs`, never two
 * at once. Returns a function that stops it.
 *
 * The interval is `unref`'d — a scheduler with nothing to do must not be what
 * keeps the process alive, the same reasoning `purgeJob.ts` gives.
 */
export function iniciarProgramador(deps: DependenciasDelProgramador, intervaloMs: number): () => void {
  let enMarcha = false;
  const pasada = () => {
    if (enMarcha) return;
    enMarcha = true;
    void tic(deps)
      .catch((err) => deps.registrar("error", { err }, "informes programados: el tic lanzó una excepción"))
      .finally(() => {
        enMarcha = false;
      });
  };
  pasada();
  const temporizador = setInterval(pasada, intervaloMs);
  temporizador.unref();
  return () => clearInterval(temporizador);
}
