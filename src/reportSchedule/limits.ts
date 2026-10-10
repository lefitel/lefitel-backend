// The numbers the scheduled reports are bounded by, in one place.
// Design: docs/specs/2026-10-10-informes-programados-design.md §3.4–§3.6.

/** Recipients on one schedule. Bounds what a single mistake can send. */
export const MAX_DESTINATARIOS = 10;

/**
 * Report messages in any twenty-four hours, across every schedule.
 *
 * The mail chain holds back a quarter of each provider for login codes and
 * security notices, and the scheduled reports are not on that list — but they
 * share the other three quarters with `/password/forgot` and the verification
 * link, and nothing stops ten daily schedules of ten recipients each from
 * spending it. So they get a ceiling of their own, well under what the chain
 * leaves unreserved (217 a day with the three providers of October 2026).
 * Counted from `reporte_ejecuciones`, so a restart does not reset it.
 */
export const MAX_CORREOS_DE_INFORMES_AL_DIA = 100;

/**
 * How late a run may still be sent. A server that was down at seven and is
 * back at nine sends the seven o'clock report; one that was down for two days
 * does not send two stale ones — those are recorded as `omitido`.
 */
export const RETRASO_MAXIMO_MS = 24 * 60 * 60 * 1000;

/** Consecutive failed runs after which a schedule pauses itself. */
export const FALLOS_PARA_PAUSAR = 3;

/**
 * Consecutive refusals of one address after which it stops being written to.
 * A refused address is a bounce, and bounces are what teach a mail provider
 * to distrust the domain the login codes also leave from.
 */
export const RECHAZOS_PARA_DEJAR = 3;

/** How long the walk of the mail chain may take for one message with a file. */
export const PLAZO_DE_ENVIO_MS = 5 * 60 * 1000;

/**
 * How long a run may sit claimed and unfinished before it is taken for dead.
 * An export is bounded by its own statement timeout and the sends by
 * `PLAZO_DE_ENVIO_MS` each, so an hour is far past anything still alive.
 */
export const EJECUCION_ABANDONADA_MS = 60 * 60 * 1000;

/** How often the scheduler looks for runs that are due. */
export const INTERVALO_DEL_PROGRAMADOR_MS = 60 * 1000;
