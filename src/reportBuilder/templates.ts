// Reports somebody can open and run without building one first.
//
// The screen offers 52 fields across 12 groups and a level-of-detail choice
// that changes what every one of them means. That is a fine tool for whoever
// already knows the shape of the data and an empty room for everybody else —
// and "everybody else" is not hypothetical here: role 3 is called "Cliente" and
// holds `generador.ver`, `crear`, `editar` and `archivar`. Nobody from outside
// the company assembles a report out of 52 fields.
//
// They live on the server rather than in the client for the reason every other
// piece of catalog knowledge does. A template is a handful of catalog paths —
// `poste.tramo`, `evento.criticidad` — so a copy of it in the web repo is the
// same cross-repo duplication that put two spellings of "máximo" and two copies
// of the caps in two places. Here the catalog and the templates change in the
// same commit, `templates.test.ts` refuses any template the builder cannot
// build, and `pruneConfig` fits each one to whoever is asking.

import { pruneConfig } from "./prune.js";
import type { ReportConfig } from "./types.js";
import type { Viewer } from "./viewer.js";

/**
 * How many rows one page of a template holds.
 *
 * Written into every one of them, and not left out: a request that carries no
 * `limit` is given 500 by the builder, while the client's own default is 100.
 * The six shipped without one, so a report opened from a template paged in
 * five-hundreds and the identical report built by hand paged in hundreds, on
 * the same screen, with nothing saying so. The test beside this file refuses a
 * template that forgets it again.
 */
export const PAGE_SIZE = 100;

export interface ReportTemplate {
  /** Stable id. The client keys on it; never reuse one for a different report. */
  key: string;
  name: string;
  /** The question it answers, in one sentence, for somebody choosing between six. */
  description: string;
  config: ReportConfig;
}

/**
 * Every template is a complete configuration, exactly as the builder stores one.
 *
 * Two rules they all keep:
 *
 *  - **No absolute dates.** A template filtered to one fixed month would be
 *    filtered to it forever, and would go on calling itself "del mes" long
 *    after it stopped being one. When these six were written no date operator
 *    was relative, so recency is expressed by sorting, which never expires.
 *    Since then `period` exists ("el mes pasado", "esta semana") and a
 *    template may use it; none does yet.
 *  - **Nothing personal.** Not one of them reads a `staffOnly` field, so all six
 *    survive `pruneConfig` intact for every role that can open this screen.
 *    That is what makes them a starting point for the Cliente role rather than
 *    six reports that quietly lose a column.
 */
export const TEMPLATES: ReportTemplate[] = [
  {
    key: "general-eventos",
    name: "General de eventos",
    description: "Todos los eventos con su poste, su propietario y su criticidad. El listado de siempre.",
    config: {
      root: "evento",
      columns: [
        { path: "poste.name" },
        { path: "poste.propietario.name" },
        { path: "description" },
        { path: "criticidad" },
        { path: "state" },
        { path: "date" },
      ],
      limit: PAGE_SIZE,
      filters: { op: "and", conditions: [] },
      groupBy: [],
      sort: [{ path: "date", dir: "desc" }],
    },
  },
  {
    key: "pendientes-por-tramo",
    name: "Pendientes por tramo",
    description: "Cuántos eventos sin resolver acumula cada tramo, y cuál es el más crítico de cada uno.",
    config: {
      root: "evento",
      columns: [
        { path: "poste.tramo" },
        { path: "id", agg: "count", label: "Pendientes" },
        // The *smallest* criticality number is the worst one on this scale, so
        // the minimum is the sharpest thing a group of events can be asked.
        { path: "criticidad", agg: "min", label: "Más crítico" },
      ],
      limit: PAGE_SIZE,
      filters: { op: "and", conditions: [{ path: "state", operator: "eq", value: false }] },
      groupBy: ["poste.tramo"],
      sort: [{ path: "id", agg: "count", dir: "desc" }],
    },
  },
  {
    key: "trabajos-hechos",
    name: "Trabajos hechos",
    description: "Cada reparación aplicada, con el evento que la motivó. Una fila por solución.",
    config: {
      root: "solucion",
      columns: [
        { path: "date" },
        { path: "evento.poste.name" },
        { path: "evento.description" },
        { path: "description" },
      ],
      limit: PAGE_SIZE,
      filters: { op: "and", conditions: [] },
      groupBy: [],
      sort: [{ path: "date", dir: "desc" }],
    },
  },
  {
    key: "revisiones-recientes",
    name: "Revisiones recientes",
    description: "Las visitas a terreno, de la más nueva a la más vieja. Una fila por revisión.",
    config: {
      root: "revision",
      columns: [
        { path: "date" },
        { path: "evento.poste.name" },
        { path: "evento.description" },
        { path: "description" },
      ],
      limit: PAGE_SIZE,
      filters: { op: "and", conditions: [] },
      groupBy: [],
      sort: [{ path: "date", dir: "desc" }],
    },
  },
  {
    key: "cobertura-por-ciudad",
    name: "Cobertura por ciudad",
    description: "Postes y eventos de cada ciudad. Ordenada de menos a más, enseña primero los huecos.",
    config: {
      root: "ciudad",
      columns: [
        { path: "name" },
        { path: "numPostes" },
        { path: "numEventos" },
        { path: "numPendientes" },
      ],
      limit: PAGE_SIZE,
      filters: { op: "and", conditions: [] },
      groupBy: [],
      // Ascending on purpose: the cities with nothing installed are the answer
      // this report exists for, and descending would bury them on the last page.
      sort: [{ path: "numPostes", dir: "asc" }],
    },
  },
  {
    key: "tiempos-de-resolucion",
    name: "Tiempos de resolución",
    description: "Cuántos días tarda de media en repararse un evento, tramo por tramo.",
    config: {
      root: "evento",
      columns: [
        { path: "poste.tramo" },
        { path: "tiempoResolucion", agg: "avg", label: "Días de media" },
        { path: "id", agg: "count", label: "Eventos" },
      ],
      // Only the resolved ones have a resolution time; without this the average
      // is taken over a column that is null for everything still open.
      limit: PAGE_SIZE,
      filters: { op: "and", conditions: [{ path: "state", operator: "eq", value: true }] },
      groupBy: ["poste.tramo"],
      sort: [{ path: "tiempoResolucion", agg: "avg", dir: "desc" }],
    },
  },
];

/**
 * The templates this viewer can actually run.
 *
 * Each one goes through the same pruning a saved report does, so a template is
 * never offered with a column the caller may not ask for. A template that lost
 * anything is dropped rather than served narrower: these exist to be a working
 * example, and an example that comes up missing a column teaches the wrong
 * lesson about the screen. None of the six loses anything today — the test
 * beside this file is what keeps that true.
 */
export function templatesFor(viewer: Viewer): ReportTemplate[] {
  return TEMPLATES.filter((template) => pruneConfig(template.config, viewer).omitted === 0);
}
