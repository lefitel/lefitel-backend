// When a scheduled report runs next — pure calendar arithmetic, no clock and
// no database. Design: docs/specs/2026-10-10-informes-programados-design.md §3.4.
//
// A schedule is an hour of the day in the report's zone, on every day, on one
// weekday, or on one day of the month. "Next" is always **strictly after** the
// instant given: the scheduler calls this with the moment a run was due to find
// the following one, and a function that could answer "now" would have the
// same run schedule itself for ever.
//
// **The zone is a constant offset, not a lookup.** `America/La_Paz` is UTC−4
// all year and has been since 1932, so wall-clock time there is the instant
// minus four hours and nothing else. Doing it with a time-zone library would
// be correct too and would buy nothing; what would be wrong is the offset
// changing unnoticed, and `nextRun.test.ts` asks `Intl` about every month of
// the year so that it cannot.

import { FRECUENCIAS } from "../models/reporteProgramacion.model.js";

/** Minutes to add to a UTC instant to read it as La Paz wall-clock time. */
export const ZONA_DESFASE_MINUTOS = -240;

export type Frecuencia = (typeof FRECUENCIAS)[number];

/** The part of a schedule that decides when it runs. */
export interface Horario {
  frecuencia: Frecuencia;
  /** 0–23. */
  hora: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. Set exactly when weekly. */
  dia_semana?: number | null;
  /** 1–28, so the day exists in every month. Set exactly when monthly. */
  dia_mes?: number | null;
}

const entero = (v: unknown, min: number, max: number): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const ausente = (v: unknown): boolean => v === null || v === undefined;

/**
 * Everything wrong with a schedule, in sentences a person can act on. Empty
 * when it is fine.
 *
 * These are the table's own CHECK constraints, asked before the insert: the
 * database would refuse the same rows, with a constraint name nobody on the
 * other side of the screen can read.
 */
export function problemasDeHorario(h: Horario): string[] {
  const problemas: string[] = [];
  if (!(FRECUENCIAS as readonly string[]).includes(h.frecuencia)) {
    return ["La frecuencia debe ser diaria, semanal o mensual."];
  }
  if (!entero(h.hora, 0, 23)) problemas.push("La hora debe ser un número entero entre 0 y 23.");

  if (h.frecuencia === "semanal") {
    if (!entero(h.dia_semana, 1, 7)) problemas.push("Un envío semanal necesita el día de la semana, de 1 (lunes) a 7 (domingo).");
    else if (!ausente(h.dia_mes)) problemas.push("Un envío semanal no lleva día del mes.");
  } else if (h.frecuencia === "mensual") {
    if (!entero(h.dia_mes, 1, 28)) problemas.push("Un envío mensual necesita el día del mes, de 1 a 28.");
    else if (!ausente(h.dia_semana)) problemas.push("Un envío mensual no lleva día de la semana.");
  } else if (!ausente(h.dia_semana) || !ausente(h.dia_mes)) {
    problemas.push("Un envío diario no lleva día de la semana ni día del mes.");
  }
  return problemas;
}

/**
 * The first instant strictly after `despuesDe` at which this schedule is due.
 *
 * Works on the wall clock: shifts the instant into La Paz, does the calendar
 * arithmetic with the UTC accessors of that shifted value (which then read as
 * local fields), and shifts the answer back.
 */
export function proximaEjecucion(h: Horario, despuesDe: Date): Date {
  const problemas = problemasDeHorario(h);
  if (problemas.length > 0) throw new Error(`Horario no válido: ${problemas.join(" ")}`);

  const desfase = ZONA_DESFASE_MINUTOS * 60_000;
  const local = new Date(despuesDe.getTime() + desfase);
  const anio = local.getUTCFullYear();
  const mes = local.getUTCMonth();
  const dia = local.getUTCDate();

  /** A La Paz wall-clock moment at the schedule's hour, as a shifted instant. */
  const a = (y: number, m: number, d: number) => Date.UTC(y, m, d, h.hora, 0, 0, 0);
  let candidato: number;

  if (h.frecuencia === "diaria") {
    candidato = a(anio, mes, dia);
    if (candidato <= local.getTime()) candidato = a(anio, mes, dia + 1);
  } else if (h.frecuencia === "semanal") {
    // `getUTCDay` has Sunday as 0 where ISO has 7. Modulo seven they are the
    // same number, so no conversion is needed — and one was written here at
    // first, which a mutation test showed changed nothing.
    const faltan = ((h.dia_semana as number) - local.getUTCDay() + 7) % 7;
    candidato = a(anio, mes, dia + faltan);
    if (candidato <= local.getTime()) candidato = a(anio, mes, dia + faltan + 7);
  } else {
    candidato = a(anio, mes, h.dia_mes as number);
    // `Date.UTC` carries month 12 into January of the next year by itself.
    if (candidato <= local.getTime()) candidato = a(anio, mes + 1, h.dia_mes as number);
  }

  return new Date(candidato - desfase);
}
