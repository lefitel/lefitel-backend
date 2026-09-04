// How bad an incident is, on the server.
//
// The severity of an incident is not stored on the incident: it is the worst
// level among the observations attached to it, where 1 is catastrophic and 9 is
// routine maintenance. That rule already existed twice — as SQL in
// `evento.controller.ts`, which is what the list filters and sorts by, and as
// TypeScript in the client's `criticality.ts`, which is what the screen paints
// — and an audit before the server-side exports were written warned that a
// third copy inside the exporter would be a third thing to drift.
//
// So the exporter does not compute it. It calls this, and this is the same rule
// as the SQL beside it: lowest level among the observations the list itself
// sends, archived observations included, because the column shows them.
//
// The names are new here. They only ever existed in the browser, and a file
// that says "3" where the screen says "Sujeto a árbol" is a file the reader has
// to decode. If they are ever edited, they are edited in two places — say so
// out loud rather than letting the two versions diverge quietly.

/** Level 1 is the worst. `null` is an incident nobody has classified. */
export type Criticidad = number | null;

/** The nine levels, in the order the catalogue defines them. */
export const ETIQUETAS_CRITICIDAD: Readonly<Record<number, string>> = {
  1: "Catastrófico",
  2: "Ferretería suelta",
  3: "Sujeto a árbol",
  4: "Daño estructural",
  5: "Vano bajo",
  6: "Fricción",
  7: "Estresado",
  8: "Antivibradores",
  9: "Mantenimiento",
};

export const SIN_CLASIFICAR = "Sin clasificar";

/**
 * The name of a level, or "Sin clasificar".
 *
 * Anything outside 1..9 is unclassified rather than an error. The range is
 * enforced by a Sequelize validator on the observation catalogue and not by a
 * CHECK in the database, so a row written by a script can sit outside it; a
 * cell reading "0 - Sin clasificar" is a worse answer than one reading
 * "Sin clasificar".
 */
export const etiquetaCriticidad = (nivel: Criticidad): string =>
  nivel !== null && Number.isInteger(nivel) ? ETIQUETAS_CRITICIDAD[nivel] ?? SIN_CLASIFICAR : SIN_CLASIFICAR;

/**
 * The worst level among an incident's observations, or `null`.
 *
 * `null` when there are no observations and when none of them carries a level:
 * "nobody has classified this" and "this has nothing wrong with it" are not the
 * same statement, and only the first is true.
 */
export const peorCriticidad = (
  eventoObs: readonly { ob?: { criticality?: number | null } | null }[] | null | undefined,
): Criticidad => {
  const niveles = (eventoObs ?? [])
    .map((eo) => eo.ob?.criticality)
    .filter((c): c is number => typeof c === "number");
  return niveles.length === 0 ? null : Math.min(...niveles);
};
