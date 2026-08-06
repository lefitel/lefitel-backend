// The indicator strip that heads an exported report.
//
// Derived from the meaning the catalog publishes for each field, never from its
// label: the user renames labels freely, and a report that miscounts is worth
// less than one that shows nothing.

import type { ResultColumn } from "../types.js";
import { isTrue } from "./values.js";

export type IndicatorTone = "neutral" | "good" | "warn" | "bad";

export interface Indicator {
  label: string;
  value: number;
  tone: IndicatorTone;
}

/**
 * Levels 1 to 3 — Catastrófico, Ferretería suelta and Sujeto a árbol — are the
 * three the application already paints red, orange and amber. Named rather than
 * inlined so the threshold is one decision in one place.
 */
export const CRITICAL_MAX_LEVEL = 3;

/**
 * Builds the strip from whatever the report happens to contain.
 *
 * Always counts rows, and `noun` names what a row is: grouping by tramo makes a
 * row a tramo, and "40 resueltos" then means forty tramos whose state column
 * says resolved. That is true as long as the noun is right, which is why it is
 * a required argument and not a default.
 *
 * A column carrying an aggregate has no semantic — the builder strips it — so a
 * count or an average can never be mistaken for a state.
 *
 * A row whose state is null counts as pending, which keeps resolved plus
 * pending equal to the total: the sum a reader checks first.
 */
export function buildIndicators(
  columns: readonly ResultColumn[],
  rows: readonly Record<string, unknown>[],
  noun: string,
): Indicator[] {
  const indicators: Indicator[] = [
    { label: noun, value: rows.length, tone: "neutral" },
  ];

  const stateKey = columns.find((column) => column.semantic === "state")?.key;
  if (stateKey !== undefined) {
    let resolved = 0;
    for (const row of rows) if (isTrue(row[stateKey])) resolved += 1;
    indicators.push({ label: "resueltos", value: resolved, tone: "good" });
    indicators.push({ label: "pendientes", value: rows.length - resolved, tone: "warn" });
  }

  const criticalityKey = columns.find((column) => column.semantic === "criticality")?.key;
  if (criticalityKey !== undefined) {
    let critical = 0;
    for (const row of rows) {
      const level = Number(row[criticalityKey]);
      if (Number.isInteger(level) && level >= 1 && level <= CRITICAL_MAX_LEVEL) critical += 1;
    }
    indicators.push({ label: "críticos", value: critical, tone: "bad" });
  }

  return indicators;
}

/** "1.376 eventos · 597 resueltos · 779 pendientes · 84 críticos" */
export function formatIndicators(indicators: readonly Indicator[]): string {
  return indicators
    .map((indicator) => `${indicator.value.toLocaleString("es-BO")} ${indicator.label}`)
    .join("  ·  ");
}
