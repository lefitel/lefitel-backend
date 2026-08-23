// Which colour a data row gets, in both formats.
//
// The rule is one decision made once: resolved beats severity, severity beats
// nothing. reportGeneral already reads that way — a solved event is green
// whatever its history — so a user moving between reports meets one criterion,
// not two.

import type { ResultColumn } from "../types.js";
import { isTrue } from "./values.js";

export type RowTint =
  | { kind: "resolved" }
  | { kind: "criticality"; level: number }
  | { kind: "band"; odd: boolean };

/** Criticality 1 is catastrophic and 9 is maintenance. */
export const CRITICALITY_HEX: Record<number, string> = {
  1: "FAD7D7", 2: "FDE8D0", 3: "FDF0DA", 4: "FEF9E0", 5: "F2F8E0",
  6: "E4F5E9", 7: "E0F3F3", 8: "E0F0F8", 9: "E8EEF8",
};

export const RESOLVED_HEX = "D4EDDA";
export const BAND_HEX = "F4F6FB";

/**
 * The keys the rule needs, resolved once for a whole report rather than
 * searched per row: a 20.000-row export would otherwise scan the column list
 * twenty thousand times.
 */
export interface RowStyleKeys {
  stateKey?: string;
  criticalityKey?: string;
}

export function rowStyleKeys(columns: readonly ResultColumn[]): RowStyleKeys {
  return {
    stateKey: columns.find((column) => column.semantic === "state")?.key,
    criticalityKey: columns.find((column) => column.semantic === "criticality")?.key,
  };
}

/**
 * Resolved wins over criticality on purpose: the question the colour answers is
 * "does this still need someone?", not "how bad was it?".
 */
export function rowTint(
  row: Record<string, unknown>,
  index: number,
  keys: RowStyleKeys,
): RowTint {
  if (keys.stateKey !== undefined && isTrue(row[keys.stateKey])) {
    return { kind: "resolved" };
  }
  if (keys.criticalityKey !== undefined) {
    const level = Number(row[keys.criticalityKey]);
    if (Number.isInteger(level) && level >= 1 && level <= 9) {
      return { kind: "criticality", level };
    }
  }
  return { kind: "band", odd: index % 2 === 1 };
}

/** Six hex digits, or null when the row should keep the sheet's own background. */
export function tintHex(tint: RowTint): string | null {
  switch (tint.kind) {
    case "resolved": return RESOLVED_HEX;
    case "criticality": return CRITICALITY_HEX[tint.level] ?? null;
    case "band": return tint.odd ? BAND_HEX : null;
  }
}

/** The same colour as three 0–255 components, for jsPDF. */
export function tintRgb(tint: RowTint): [number, number, number] | null {
  const hex = tintHex(tint);
  if (hex === null) return null;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** Legend shown next to the indicator strip, limited to what the report uses. */
export function legendFor(keys: RowStyleKeys): { hex: string; label: string }[] {
  const legend: { hex: string; label: string }[] = [];
  if (keys.stateKey !== undefined) legend.push({ hex: RESOLVED_HEX, label: "Resuelto" });
  if (keys.criticalityKey !== undefined) {
    legend.push({ hex: CRITICALITY_HEX[1], label: "Crítico (1-3)" });
    legend.push({ hex: CRITICALITY_HEX[4], label: "Medio (4-6)" });
    legend.push({ hex: CRITICALITY_HEX[9], label: "Leve (7-9)" });
  }
  return legend;
}
