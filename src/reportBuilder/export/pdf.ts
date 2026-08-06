// Builds the printable document for a dynamic report.
//
// A band across the top rather than a cover page: this is a tabular report, not
// a bound one, and a sheet of paper announcing a single page of data reads as
// pretentious. Paginated Power BI, Crystal Reports and Metabase all band.

import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import type { ResultColumn } from "../types.js";
import { buildIndicators } from "./indicators.js";
import { rowStyleKeys, rowTint, tintRgb } from "./rowStyle.js";
import { formatValue, toWinAnsi } from "./values.js";
import { loadBranding } from "./branding.js";

type Rgb = [number, number, number];

const NAVY: Rgb = [0, 31, 93];
const MUTED: Rgb = [107, 114, 128];
const TEXT: Rgb = [31, 41, 55];
const BAND_ROW: Rgb = [244, 246, 251];

const TONE_RGB: Record<string, Rgb> = {
  neutral: [31, 41, 55],
  good: [22, 163, 74],
  warn: [180, 83, 9],
  bad: [220, 38, 38],
};

/** Millimetres a column needs to stay readable. */
const MIN_COLUMN_MM = 18;
/** Always A4 landscape: A3 does not fit in an office printer. */
const PAGE = { orientation: "l" as const, format: "a4", usableMm: 297 - 16 };

/** Where the table starts under each kind of band. */
const FULL_BAND_MM = 26;
const FULL_TOP_MM = 40;
const THIN_BAND_MM = 13;
const THIN_TOP_MM = 18;

/**
 * Splits the columns into groups that fit the page width.
 *
 * Choosing orientation from the column count alone produced a 60-column A3 with
 * 3.5 mm columns, a header 103 mm tall and titles broken one letter per line.
 */
export function chunkColumns<T>(
  columns: readonly T[],
  perPage = Math.floor(PAGE.usableMm / MIN_COLUMN_MM),
): T[][] {
  if (columns.length === 0) return [[]];
  const size = Math.max(1, perPage);
  const chunks: T[][] = [];
  for (let i = 0; i < columns.length; i += size) chunks.push(columns.slice(i, i + size));
  return chunks;
}

export interface PdfInput {
  columns: readonly ResultColumn[];
  rows: readonly Record<string, unknown>[];
  title: string;
  subtitle?: string | null;
  /** What one row is: "eventos", "tramos". Names the first indicator. */
  noun: string;
}

export async function buildPdf(input: PdfInput): Promise<Buffer> {
  const { columns, rows } = input;
  const doc = new jsPDF({ orientation: PAGE.orientation, unit: "mm", format: PAGE.format });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const branding = await loadBranding();
  const osefi = branding.osefi ? `data:image/png;base64,${branding.osefi.toString("base64")}` : null;
  const tigo = branding.tigo ? `data:image/png;base64,${branding.tigo.toString("base64")}` : null;

  const keys = rowStyleKeys(columns);
  const indicators = buildIndicators(columns, rows, input.noun);
  const groups = chunkColumns(columns);

  const title = toWinAnsi(input.title);
  const subtitle = toWinAnsi([
    input.subtitle?.trim() || null,
    `Generado el ${new Date().toLocaleDateString("es-BO")}`,
  ].filter(Boolean).join("  ·  "));

  /** "parte 2 de 3", or nothing when the report fits on one width. */
  const partLabel = (groupIndex: number) =>
    groups.length > 1 ? `parte ${groupIndex + 1} de ${groups.length}` : null;

  /** Logos, title, subtitle and the indicator strip. Once, on the first page. */
  const drawFullBand = (groupIndex: number) => {
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, pageWidth, FULL_BAND_MM, "F");
    if (osefi) doc.addImage(osefi, "PNG", 8, 4, 18, 18);
    if (tigo) doc.addImage(tigo, "PNG", pageWidth - 30, 7, 22, 12);

    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(title, 30, 12, { maxWidth: pageWidth - 68 });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(200, 210, 230);
    // The part belongs here too. Without it the reader got "parte 2 de 3" and
    // "parte 3 de 3" and nothing saying the first page was part 1.
    const part = partLabel(groupIndex);
    doc.text(part ? `${subtitle}  ·  ${part}` : subtitle, 30, 19, { maxWidth: pageWidth - 68 });

    // The strip sits below the band, on white, where the numbers can carry
    // their own colour instead of fighting the navy.
    let x = 8;
    doc.setFontSize(9);
    indicators.forEach((indicator, index) => {
      const value = indicator.value.toLocaleString("es-BO");
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...(TONE_RGB[indicator.tone] ?? TEXT));
      doc.text(value, x, FULL_BAND_MM + 6);
      x += doc.getTextWidth(value) + 1.5;

      const label = toWinAnsi(indicator.label) + (index < indicators.length - 1 ? "   ·   " : "");
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...MUTED);
      doc.text(label, x, FULL_BAND_MM + 6);
      x += doc.getTextWidth(label);
    });
  };

  /** Everything after the first page: enough to know what one is holding. */
  const drawThinBand = (groupIndex: number) => {
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, pageWidth, THIN_BAND_MM, "F");
    if (osefi) doc.addImage(osefi, "PNG", 8, 2, 9, 9);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    const part = partLabel(groupIndex);
    doc.text(part ? `${title}  (${part})` : title, 21, 8.5, { maxWidth: pageWidth - 30 });
  };

  let bandDrawn = false;

  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) doc.addPage();

    autoTable(doc, {
      startY: groupIndex === 0 ? FULL_TOP_MM : THIN_TOP_MM,
      head: [group.map((c) => toWinAnsi(c.label))],
      body: rows.map((row) => group.map((c) => toWinAnsi(formatValue(row[c.key], c.kind)))),
      styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak", textColor: TEXT },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontSize: 7.5, fontStyle: "bold" },
      alternateRowStyles: { fillColor: BAND_ROW },
      columnStyles: Object.fromEntries(
        group.map((c, i) => [i, c.kind === "number" ? { halign: "right" as const } : {}]),
      ),
      // Room for the thin band on every continuation page; the first page of
      // the report uses startY instead, which is taller.
      margin: { left: 8, right: 8, top: THIN_TOP_MM, bottom: 14 },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const rgb = tintRgb(rowTint(rows[data.row.index] ?? {}, data.row.index, keys));
        if (rgb) data.cell.styles.fillColor = rgb;
      },
      didDrawPage: () => {
        if (!bandDrawn) { drawFullBand(groupIndex); bandDrawn = true; }
        else drawThinBand(groupIndex);
      },
    });
  });

  // Page numbers last: the total is not known until the tables are laid out.
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.setDrawColor(208, 216, 239);
    doc.line(8, pageHeight - 9, pageWidth - 8, pageHeight - 9);
    doc.text("Osefi srl", 8, pageHeight - 5);
    doc.text(`Pagina ${page} de ${pageCount}`, pageWidth - 8, pageHeight - 5, { align: "right" });
  }

  return Buffer.from(doc.output("arraybuffer"));
}
