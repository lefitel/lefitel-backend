// Builds the spreadsheet for a dynamic report.
//
// The hand-written exporters fix their column map at compile time. This one
// receives whatever columns the user chose and lays the sheet out at run time,
// keeping the visual language the client already recognises: navy band, logos,
// indicator strip, frozen headings and colour by state or severity.

import ExcelJS from "exceljs";
import type { ResultColumn } from "../types.js";
import { buildIndicators, type Indicator } from "./indicators.js";
import { legendFor, rowStyleKeys, rowTint, tintHex } from "./rowStyle.js";
import { isTrue, reportDateLabel, toZonedExcelDate } from "./values.js";
import { loadBranding } from "./branding.js";
import type { LoadedPhotos } from "./photos.js";

const CLR = {
  navy: "FF001F5D",
  white: "FFFFFFFF",
  border: "FFD0D7EF",
  text: "FF1F2937",
  muted: "FF6B7280",
  stripBg: "FFF8F9FA",
} as const;

const TONE_COLOUR: Record<Indicator["tone"], string> = {
  neutral: "FF1F2937",
  good: "FF16A34A",
  warn: "FFB45309",
  bad: "FFDC2626",
};

const thin = { style: "thin" as const, color: { argb: CLR.border } };

/** Excel's own limit, not ours. */
const MAX_CELL_TEXT = 32_767;

/** Row 1 title, 2 subtitle, 3 indicators, 4 headers, 5+ data. */
const ROW = { TITLE: 1, SUBTITLE: 2, STRIP: 3, HEADER: 4, DATA: 5 } as const;

const HEIGHT = { TITLE: 46, SUBTITLE: 16, STRIP: 18, WITH_PHOTO: 84, PLAIN: 30 } as const;

export interface ExcelInput {
  columns: readonly ResultColumn[];
  rows: readonly Record<string, unknown>[];
  title: string;
  subtitle?: string | null;
  /** What one row is: "eventos", "tramos". Names the first indicator. */
  noun: string;
  photos?: LoadedPhotos | null;
}

/** Native dates and numbers, so the reader can still sort and filter. */
function cellValue(raw: unknown, kind: ResultColumn["kind"]): string | number | Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (kind) {
    case "number": {
      const n = Number(raw);
      // Infinity is not a valid xsd:double: Excel reports the file as damaged.
      return Number.isFinite(n) ? n : String(raw).slice(0, MAX_CELL_TEXT);
    }
    case "date": {
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) return String(raw).slice(0, MAX_CELL_TEXT);
      return toZonedExcelDate(date) ?? String(raw).slice(0, MAX_CELL_TEXT);
    }
    case "boolean":
      return isTrue(raw) ? "Sí" : "No";
    case "image":
      // The photograph itself goes in as a drawing. This is the fallback for
      // one that could not be read, and it is never the stored path: photos are
      // served unauthenticated, so a path would turn the sheet into a list of
      // publicly fetchable field photographs.
      return "Sí";
    default:
      return String(raw).slice(0, MAX_CELL_TEXT);
  }
}

/** Width from what the reader sees, not from the raw value. */
function displayWidth(raw: unknown, kind: ResultColumn["kind"]): number {
  if (raw === null || raw === undefined) return 0;
  switch (kind) {
    case "date": return 10;   // dd/mm/yyyy
    case "boolean": return 3; // Sí / No
    case "image": return 14;  // the drawing, not the text
    default: return String(raw).length;
  }
}

export async function buildExcel(input: ExcelInput): Promise<Buffer> {
  const { columns, rows } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Osefi srl";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Reporte", {
    views: [{ state: "frozen", ySplit: ROW.HEADER }],
  });
  const lastCol = Math.max(1, columns.length);

  const keys = rowStyleKeys(columns);
  const indicators = buildIndicators(columns, rows, input.noun);
  const legend = legendFor(keys);
  const photos = input.photos ?? null;

  // ── Column widths, first: the header height depends on them ────────────────
  const widths = columns.map((column, index) => {
    const longest = rows.reduce(
      (max, row) => Math.max(max, displayWidth(row[column.key], column.kind)),
      column.label.length,
    );
    const width = column.kind === "image" ? 16 : Math.min(48, Math.max(10, longest + 2));
    sheet.getColumn(index + 1).width = width;
    return width;
  });

  // ── Row 1: title, with the logos floating over it ──────────────────────────
  sheet.mergeCells(ROW.TITLE, 1, ROW.TITLE, lastCol);
  const titleCell = sheet.getCell(ROW.TITLE, 1);
  titleCell.value = input.title;
  titleCell.font = { name: "Segoe UI", size: 15, bold: true, color: { argb: CLR.white } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.navy } };
  titleCell.alignment = { vertical: "middle", horizontal: "center" };
  sheet.getRow(ROW.TITLE).height = HEIGHT.TITLE;

  const branding = await loadBranding();
  if (branding.osefi) {
    sheet.addImage(workbook.addImage({ buffer: branding.osefi as never, extension: "png" }), {
      tl: { col: 0.2, row: 0.15 }, ext: { width: 56, height: 40 },
    });
  }
  // Only when the sheet is wide enough for it not to land on the title.
  if (branding.tigo && lastCol >= 3) {
    sheet.addImage(workbook.addImage({ buffer: branding.tigo as never, extension: "png" }), {
      tl: { col: lastCol - 0.9, row: 0.15 }, ext: { width: 56, height: 40 },
    });
  }

  // ── Row 2: subtitle ────────────────────────────────────────────────────────
  sheet.mergeCells(ROW.SUBTITLE, 1, ROW.SUBTITLE, lastCol);
  const subtitleCell = sheet.getCell(ROW.SUBTITLE, 1);
  // A file that quietly omits what was asked for is worse than one that refuses
  // to make it. Both reasons for a missing photograph are named, and they are
  // different problems: the cap is the report being too big, a failed read is
  // the file not being on this server.
  const warnings = [
    photos && photos.skipped > 0
      ? `SIN ${photos.skipped} FOTO${photos.skipped === 1 ? "" : "S"}: ` +
        `se alcanzó el máximo de fotos por archivo`
      : null,
    photos && photos.failed > 0
      ? `SIN ${photos.failed} FOTO${photos.failed === 1 ? "" : "S"}: no se pudo leer el archivo`
      : null,
  ].filter(Boolean);

  subtitleCell.value = [
    input.subtitle?.trim() || null,
    ...warnings,
    `Generado el ${reportDateLabel()}`,
  ].filter(Boolean).join("  ·  ");
  subtitleCell.font = {
    name: "Segoe UI", size: 9, color: { argb: CLR.muted },
    bold: warnings.length > 0,
  };
  subtitleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(ROW.SUBTITLE).height = HEIGHT.SUBTITLE;

  // ── Row 3: indicators on the left, legend on the right ─────────────────────
  const splitAt = legend.length > 0 && lastCol >= 4 ? Math.ceil(lastCol / 2) : lastCol;

  sheet.mergeCells(ROW.STRIP, 1, ROW.STRIP, splitAt);
  const stripCell = sheet.getCell(ROW.STRIP, 1);
  stripCell.value = {
    richText: indicators.flatMap((indicator, index) => [
      {
        text: indicator.value.toLocaleString("es-BO"),
        font: { name: "Segoe UI", size: 9, bold: true, color: { argb: TONE_COLOUR[indicator.tone] } },
      },
      {
        text: ` ${indicator.label}${index < indicators.length - 1 ? "   ·   " : ""}`,
        font: { name: "Segoe UI", size: 9, color: { argb: CLR.muted } },
      },
    ]),
  };
  stripCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  stripCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.stripBg } };

  if (splitAt < lastCol) {
    sheet.mergeCells(ROW.STRIP, splitAt + 1, ROW.STRIP, lastCol);
    const legendCell = sheet.getCell(ROW.STRIP, splitAt + 1);
    legendCell.value = {
      richText: legend.flatMap((entry, index) => [
        { text: "■ ", font: { name: "Segoe UI", size: 10, color: { argb: `FF${entry.hex}` } } },
        {
          text: entry.label + (index < legend.length - 1 ? "   " : ""),
          font: { name: "Segoe UI", size: 9, color: { argb: CLR.text } },
        },
      ]),
    };
    legendCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    legendCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.stripBg } };
  }
  sheet.getRow(ROW.STRIP).height = HEIGHT.STRIP;

  // ── Row 4: headers ─────────────────────────────────────────────────────────
  const headerRow = sheet.getRow(ROW.HEADER);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: CLR.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.navy } };
    cell.alignment = {
      vertical: "middle",
      horizontal: column.kind === "number" ? "right" : "left",
      wrapText: true,
    };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });
  // Tall enough for the longest header to wrap rather than be clipped.
  const headerLines = columns.reduce(
    (max, column, index) => Math.max(max, Math.ceil(column.label.length / Math.max(1, widths[index]))),
    1,
  );
  headerRow.height = Math.min(90, Math.max(22, headerLines * 14));

  /**
   * One media entry per distinct photograph, however many rows show it.
   *
   * `workbook.addImage` does not deduplicate — it pushes and hands back a fresh
   * id every time — and it used to be called once per row, so a report where
   * many rows share a photograph embedded that JPEG once per row. Measured on
   * the live data: 7.337 rows over 1.375 distinct photographs produced a 38,6 MB
   * file and 425 MB of RSS, against 0,12 MB once the ids are reused. A single
   * photograph repeated across a report at the cell ceiling reached a gigabyte,
   * on a server that has four and shares them with Postgres.
   */
  const mediaIds = new Map<Buffer, number>();
  const mediaId = (buffer: Buffer): number => {
    let id = mediaIds.get(buffer);
    if (id === undefined) {
      id = workbook.addImage({ buffer: buffer as never, extension: "jpeg" });
      mediaIds.set(buffer, id);
    }
    return id;
  };

  // ── Data ───────────────────────────────────────────────────────────────────
  rows.forEach((row, rowIndex) => {
    const excelRowNumber = ROW.DATA + rowIndex;
    const excelRow = sheet.getRow(excelRowNumber);
    const fill = tintHex(rowTint(row, rowIndex, keys));

    let hasPhoto = false;
    columns.forEach((column, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      const raw = row[column.key];

      const embedded = column.kind === "image" && photos
        ? photos.images.get(typeof raw === "string" ? raw : "")
        : undefined;

      if (embedded) {
        hasPhoto = true;
        cell.value = null;
        // Anchored to both corners so the photograph fills the cell and follows
        // it when the column is resized. ExcelJS's Anchor type demands internal
        // fields it fills in itself.
        sheet.addImage(mediaId(embedded), {
          tl: { col: colIndex + 0.06, row: excelRowNumber - 1 + 0.06 } as ExcelJS.Anchor,
          br: { col: colIndex + 0.94, row: excelRowNumber - 0.06 } as ExcelJS.Anchor,
        });
      } else {
        cell.value = cellValue(raw, column.kind);
      }

      cell.font = { name: "Segoe UI", size: 10, color: { argb: CLR.text } };
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      cell.alignment = {
        vertical: column.kind === "image" ? "middle" : "top",
        horizontal: column.kind === "number" ? "right" : "left",
        wrapText: column.kind === "string",
      };
      if (column.kind === "date") cell.numFmt = "dd/mm/yyyy";
      if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${fill}` } };
    });

    // Explicit height always: with wrapText and none, one long description grows
    // the row to Excel's 409-point maximum and swallows the screen.
    excelRow.height = hasPhoto ? HEIGHT.WITH_PHOTO : HEIGHT.PLAIN;
  });

  if (columns.length > 0 && rows.length > 0) {
    sheet.autoFilter = {
      from: { row: ROW.HEADER, column: 1 },
      to: { row: ROW.HEADER, column: lastCol },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export { cellValue, displayWidth };
