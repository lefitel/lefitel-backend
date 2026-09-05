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
 *  - **No absolute dates.** The date operators are `between`, `gte`, `lte`,
 *    `isnull` and `notnull`; none of them is relative. A template filtered to
 *    "this month" would be filtered to one fixed month forever, and would go on
 *    calling itself "del mes" long after it stopped being one. Where recency
 *    matters it is expressed by sorting, which never expires.
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
