// What changing a schedule does to the things that are not simply overwritten:
// its recipients and its next run. Pure, so the two rules that are easy to get
// wrong are tested without a database.

import type { MotivoDePausa } from "./run.js";
import { proximaEjecucion, type Horario } from "./nextRun.js";

export interface DestinatarioGuardado {
  id: number;
  id_usuario?: number | null;
  email?: string | null;
  baja_at?: Date | null;
}

export type DestinatarioNuevo = { id_usuario: number } | { email: string };

/**
 * Which recipient rows to delete and which to add so that a schedule ends up
 * with the recipients asked for.
 *
 * **Reconciled, not replaced.** A row that stays keeps what is known about it:
 * how many times its address was refused, and above all that it unsubscribed.
 *
 * 🔴 **A row that unsubscribed is never deleted, and is never added again.**
 * Deleting it would forget the unsubscribe; the owner removing the address and
 * typing it back in — by mistake or on purpose — would then write to somebody
 * who asked not to be written to. So it stays in the table whatever the
 * request says, and because it stays, asking for that address again creates
 * nothing.
 */
export function reconciliarDestinatarios(
  existentes: DestinatarioGuardado[],
  pedidos: { usuarios: number[]; correos: string[] },
): { borrar: number[]; crear: DestinatarioNuevo[] } {
  const esCuenta = (d: DestinatarioGuardado): d is DestinatarioGuardado & { id_usuario: number } =>
    typeof d.id_usuario === "number";

  const borrar = existentes
    .filter((d) => !d.baja_at)
    .filter((d) => (esCuenta(d) ? !pedidos.usuarios.includes(d.id_usuario) : !pedidos.correos.includes(d.email as string)))
    .map((d) => d.id);

  const crear: DestinatarioNuevo[] = [
    ...pedidos.usuarios.filter((id) => !existentes.some((d) => d.id_usuario === id)).map((id_usuario) => ({ id_usuario })),
    ...pedidos.correos.filter((email) => !existentes.some((d) => d.email === email)).map((email) => ({ email })),
  ];
  return { borrar, crear };
}

export interface EstadoDeProgramacion extends Horario {
  activa: boolean;
  proxima_ejecucion?: Date | null;
  motivo_pausa?: string | null;
  fallos_seguidos: number;
}

/**
 * The next run, the reason for a pause and the count of failures after an
 * edit.
 *
 * **The next run moves only when something that decides it changed**, or when
 * the schedule comes back from a pause. Recomputing it on every save would
 * make adding a recipient on Monday at 06:59 push a 07:00 report to — well,
 * the same 07:00, but saving at 07:00:30 while the tick is still working on
 * it would push it to next week, with the report possibly never sent.
 *
 * **Coming back from a pause is a clean start**: the failures that caused it
 * are forgotten, or the first new one would pause it again.
 */
export function estadoTrasEditar(
  actual: EstadoDeProgramacion,
  pedida: Horario & { activa: boolean },
  ahora: Date,
): { proxima_ejecucion: Date | null; motivo_pausa: MotivoDePausa | null; fallos_seguidos: number } {
  if (!pedida.activa) {
    return {
      proxima_ejecucion: null,
      // Pausing by hand says so; a schedule that was already paused for a
      // reason of its own keeps that reason.
      motivo_pausa: actual.activa ? "manual" : ((actual.motivo_pausa as MotivoDePausa | null | undefined) ?? "manual"),
      fallos_seguidos: actual.fallos_seguidos,
    };
  }
  const cambioDeHorario =
    actual.frecuencia !== pedida.frecuencia ||
    actual.hora !== pedida.hora ||
    (actual.minuto ?? 0) !== (pedida.minuto ?? 0) ||
    (actual.dia_semana ?? null) !== (pedida.dia_semana ?? null) ||
    (actual.dia_mes ?? null) !== (pedida.dia_mes ?? null);
  const reactivada = !actual.activa;
  return {
    proxima_ejecucion:
      cambioDeHorario || reactivada || !actual.proxima_ejecucion
        ? proximaEjecucion(pedida, ahora)
        : actual.proxima_ejecucion,
    motivo_pausa: null,
    fallos_seguidos: reactivada ? 0 : actual.fallos_seguidos,
  };
}
