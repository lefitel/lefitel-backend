// Reading what a client sends to create or change a schedule — pure, so every
// refusal can be tested without Express. Design §3.6 and §3.8.
//
// Everything is refused here, in sentences, before it reaches the table: the
// CHECK constraints would refuse the same rows with a constraint name nobody
// on the other side of the screen can read.

import { FORMATOS_PROGRAMABLES } from "../models/reporteProgramacion.model.js";
import type { ExportFormat } from "../reportBuilder/export/index.js";
import { MAX_DESTINATARIOS } from "./limits.js";
import { problemasDeHorario, type Frecuencia, type Horario } from "./nextRun.js";

/**
 * The same shape `/auth/email/send` accepts for a recovery address: something,
 * an at sign, something with a dot — and no separator that would let one box
 * carry two addresses. Deliverability is the provider's to judge; this only
 * keeps out what is plainly not one address.
 */
const FORMA_DE_CORREO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_LARGO_DE_CORREO = 255;

export interface ProgramacionPedida extends Horario {
  id_reporte: number;
  formato: ExportFormat;
  con_fotos: boolean;
  activa: boolean;
  /** Accounts of the system, by id. Distinct. */
  usuarios: number[];
  /** Outside addresses, trimmed and lower-cased. Distinct. */
  correos: string[];
}

export type LecturaDeProgramacion =
  | { ok: true; valor: ProgramacionPedida; problemas?: undefined }
  | { ok: false; problemas: string[]; valor?: undefined };

const esEnteroPositivo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** `null` and `undefined` are the same answer here: "not given". */
const dado = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

export function leerProgramacion(cuerpo: unknown): LecturaDeProgramacion {
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) {
    return { ok: false, problemas: ["La programación no tiene la forma esperada."] };
  }
  const c = cuerpo as Record<string, unknown>;
  const problemas: string[] = [];

  if (!esEnteroPositivo(c.id_reporte)) problemas.push("Falta el informe que se va a enviar.");

  const horario: Horario = {
    frecuencia: c.frecuencia as Frecuencia,
    hora: c.hora as number,
    // Not sent means on the dot. Sent and wrong is refused below, not rounded.
    minuto: c.minuto === undefined || c.minuto === null ? 0 : (c.minuto as number),
    dia_semana: dado(c.dia_semana as number | null | undefined),
    dia_mes: dado(c.dia_mes as number | null | undefined),
  };
  problemas.push(...problemasDeHorario(horario));

  const formato = (FORMATOS_PROGRAMABLES as readonly unknown[]).includes(c.formato) ? (c.formato as ExportFormat) : null;
  if (!formato) problemas.push("El formato debe ser Excel o PDF.");

  if (c.con_fotos !== undefined && typeof c.con_fotos !== "boolean") problemas.push("«Con fotos» debe ser sí o no.");
  if (c.activa !== undefined && typeof c.activa !== "boolean") problemas.push("«Activa» debe ser sí o no.");

  const d = (c.destinatarios ?? {}) as Record<string, unknown>;
  if (typeof d !== "object" || d === null || Array.isArray(d)) {
    problemas.push("Los destinatarios no tienen la forma esperada.");
    return { ok: false, problemas };
  }

  const usuariosCrudos = d.usuarios ?? [];
  const correosCrudos = d.correos ?? [];
  let usuarios: number[] = [];
  let correos: string[] = [];

  if (!Array.isArray(usuariosCrudos) || !usuariosCrudos.every(esEnteroPositivo)) {
    problemas.push("La lista de usuarios destinatarios no es válida.");
  } else {
    usuarios = [...new Set(usuariosCrudos)];
  }

  if (!Array.isArray(correosCrudos) || !correosCrudos.every((v) => typeof v === "string")) {
    problemas.push("La lista de correos externos no es válida.");
  } else {
    const limpios = (correosCrudos as string[]).map((v) => v.trim().toLowerCase()).filter((v) => v !== "");
    const malos = limpios.filter((v) => v.length > MAX_LARGO_DE_CORREO || !FORMA_DE_CORREO.test(v));
    if (malos.length > 0) {
      // Named, so the person can find it among ten. Their own input, shown
      // back to them and to nobody else.
      problemas.push(`No ${malos.length === 1 ? "es una dirección válida" : "son direcciones válidas"}: ${malos.map((m) => m.slice(0, 60)).join(", ")}.`);
    }
    correos = [...new Set(limpios)];
  }

  const total = usuarios.length + correos.length;
  if (problemas.length === 0 && total === 0) problemas.push("Añada al menos un destinatario.");
  if (total > MAX_DESTINATARIOS) {
    problemas.push(`Una programación admite como máximo ${MAX_DESTINATARIOS} destinatarios, y esta tiene ${total}.`);
  }

  if (problemas.length > 0 || !formato) return { ok: false, problemas };

  return {
    ok: true,
    valor: {
      id_reporte: c.id_reporte as number,
      ...horario,
      formato,
      // Photographs are an Excel matter: the exporter ignores them in a PDF,
      // and storing `true` there would have the screen offer a choice that
      // changes nothing.
      con_fotos: formato === "excel" && c.con_fotos === true,
      activa: c.activa !== false,
      usuarios,
      correos,
    },
  };
}
