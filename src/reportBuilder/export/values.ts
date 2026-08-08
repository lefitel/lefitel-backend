// How a raw database value becomes something a person reads.
//
// Ported from the client's reportConfig.ts so the spreadsheet, the document and
// the preview agree to the character. The rules — and the reasons behind them —
// are the ones already proven there.

import type { FieldKind } from "../types.js";
import { REPORT_TIME_ZONE } from "../catalog.js";

// The zone belongs to the engine, not to this module: the builder filters by it
// and these formatters render by it, and the two drifting apart is what let a
// filter and the cell it produced disagree about which day a row belongs to.
export { REPORT_TIME_ZONE };

const dateFormatter = new Intl.DateTimeFormat("es-BO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: REPORT_TIME_ZONE,
});

const numberFormatter = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 2 });

/**
 * Postgres drivers hand booleans back as true, 1 or "t" depending on the column
 * and on the aggregate applied to it. Anything unrecognised reads as false.
 */
export function isTrue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    return normalised === "true" || normalised === "t" || normalised === "1";
  }
  return false;
}

export function formatValue(value: unknown, kind: FieldKind): string {
  if (value === null || value === undefined || value === "") return "—";

  switch (kind) {
    case "boolean":
      return isTrue(value) ? "Sí" : "No";
    case "date": {
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
    }
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      // Whole numbers keep their exact form — an id must stay readable as an id
      // — while averages are rounded and grouped for the locale.
      return Number.isInteger(n) ? String(n) : numberFormatter.format(n);
    }
    case "image":
      // Never the stored path. In the spreadsheet the photograph itself is
      // embedded; everywhere else this is all the reader gets.
      return "Sí";
    default:
      return String(value);
  }
}

const MIN_DATE_SERIAL = 1;
const MAX_DATE_SERIAL = 2_958_465;

/**
 * Shifts an instant so ExcelJS writes the wall-clock time of the report's zone.
 *
 * ExcelJS turns a Date into a serial with `25569 + t / 86400000`, which is UTC.
 * An event stored at 02:00 UTC therefore showed 05/08 in the spreadsheet and
 * 04/08 in the preview and the document — one report, two dates.
 */
export function toZonedExcelDate(d: Date): Date | null {
  // Range-check the instant itself. Intl cannot be trusted to round-trip years
  // outside the common era window: it silently returned 1901 for year 1.
  const rawSerial = 25569 + d.getTime() / 86_400_000;
  if (!Number.isFinite(rawSerial) || rawSerial < MIN_DATE_SERIAL || rawSerial > MAX_DATE_SERIAL) {
    return null;
  }
  const parts = Object.fromEntries(
    zoneParts.formatToParts(d)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second,
  ));
}

const zoneParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

/**
 * Replaces characters the standard PDF fonts cannot encode.
 *
 * jsPDF's built-in Helvetica is WinAnsi. A single emoji made an entire cell come
 * out as raw UTF-16, so one character typed from a phone rendered a whole
 * description unreadable.
 */
export function toWinAnsi(text: string): string {
  const replacements: Record<string, string> = {
    "✓": "Si", "✔": "Si", "✕": "No", "✗": "No", "→": "->", "←": "<-",
    "≥": ">=", "≤": "<=", "–": "-", "—": "-", "…": "...", "•": "-",
  };
  let out = "";
  for (const character of text) {
    if (replacements[character] !== undefined) { out += replacements[character]; continue; }
    const code = character.codePointAt(0) ?? 0;
    out += code <= 0xff ? character : "?";
  }
  return out;
}

const stampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: REPORT_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * The wall clock in the zone the report is read in.
 *
 * The stamp and the heading used to come from the server's own clock. The
 * runtime image sets no `TZ`, so production runs in UTC and every export made
 * after 20:00 in Bolivia was headed and named with the following day — while
 * the rows, the log entry and the user's screen all said today.
 */
function zonedParts(now: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of stampFormatter.formatToParts(now)) parts[part.type] = part.value;
  // ICU renders midnight as hour 24 under h23/h24 conventions.
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

/** "Generado el" line, in the zone the reader is in. */
export function reportDateLabel(now = new Date()): string {
  const { day, month, year } = zonedParts(now);
  return `${day}/${month}/${year}`;
}

/**
 * File name for an exported report: title, then a timestamp down to the second
 * so two exports in the same minute do not collide.
 */
export function reportFileName(title: string, extension: string, now = new Date()): string {
  const { day, month, year, hour, minute, second } = zonedParts(now);
  const stamp = `${day}-${month}-${year}_${hour}-${minute}-${second}`;
  // Strip the forbidden characters, then check what is left: a title made only
  // of slashes used to become "---" rather than falling back.
  const cleaned = title.replace(/[/:*?"<>|\\]/g, " ").replace(/\s+/g, " ").trim();
  // Cutting is itself what splits a surrogate pair, so the half-character is
  // removed after the cut and not before — and there are two cuts, the 120 the
  // controller applies to the title and the 60 here. A lone surrogate is
  // neither whitespace nor forbidden, so it survived to `encodeURIComponent`,
  // which throws on it: a title ending in an emoji became a 500 raised after
  // the entire file had already been built.
  const base = cleaned
    .slice(0, 60)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .trim();
  return `${base || "Reporte"}_${stamp}.${extension}`;
}
