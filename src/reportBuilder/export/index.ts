// Turns a report configuration into a file.
//
// The client sends the configuration, never the rows: the browser used to
// download the whole result set as JSON only to upload it again, and the file
// was built from a copy that could be minutes old. Here the query runs against
// a consistent read, moments before the file exists.

import { countReport, runReport } from "../execute.js";
import { buildQuery } from "../sqlBuilder.js";
import { rowNoun } from "../catalogView.js";
import type { ReportConfig } from "../types.js";
import { buildExcel } from "./excel.js";
import { buildPdf } from "./pdf.js";
import { loadPhotos, MAX_EXPORT_PHOTOS, type LoadedPhotos } from "./photos.js";
import { reportFileName } from "./values.js";

export type ExportFormat = "excel" | "pdf";

/** No report is a report at this height, whatever its width. */
export const MAX_EXPORT_ROWS = 20_000;

/**
 * The real limit is cells, not rows, and it is different for each format.
 *
 * Measured, one clean process per case:
 *
 * | Excel            | peso   | tiempo | RSS    |
 * |------------------|--------|--------|--------|
 * | 20.000 × 10      | 1,1 MB | 3,1 s  | 446 MB |
 * | 10.000 × 20      | 1,1 MB | 3,1 s  | 474 MB |
 * |  5.000 × 40      | 1,1 MB | 3,4 s  | 475 MB |
 * | 20.000 × 30      | 3,4 MB | 9,0 s  | 1,25 GB|
 *
 * Three different shapes of 200.000 cells all land on the same memory, which is
 * what makes cells the honest unit. ExcelJS holds the whole workbook, and the
 * server shares four gigabytes with Postgres, so 200.000 is where it stops.
 *
 * | PDF              | peso    | tiempo |
 * |------------------|---------|--------|
 * |  5.000 × 10      | 15,1 MB | 3,6 s  |
 * | 10.000 × 10      | 30,1 MB | 6,5 s  |
 * | 20.000 × 60      | 401  MB | 89,6 s |
 *
 * A document costs roughly 0,3 MB per thousand cells and its memory is flat, so
 * what binds is the person receiving it: 80.000 cells is about 25 MB, which is
 * the largest attachment most mail servers accept.
 */
export const MAX_EXPORT_CELLS: Record<ExportFormat, number> = {
  excel: 200_000,
  pdf: 80_000,
};

const CONTENT_TYPE: Record<ExportFormat, string> = {
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

const es = (n: number) => n.toLocaleString("es-BO");

/**
 * Thrown when the report is larger than an export can hold. Answered with 413.
 *
 * The message names both levers, because the limit has two: a report can be too
 * tall or too wide, and telling someone only "too many rows" when they have
 * sixty columns sends them to filter the wrong thing.
 */
export class ExportTooLargeError extends Error {
  constructor(
    readonly rows: number,
    readonly columns: number,
    readonly format: ExportFormat,
  ) {
    const cells = rows * columns;
    const cellLimit = MAX_EXPORT_CELLS[format];
    const what = format === "excel" ? "hoja de cálculo" : "documento";
    super(
      rows > MAX_EXPORT_ROWS
        ? `El reporte tiene ${es(rows)} filas y el máximo por archivo es ` +
          `${es(MAX_EXPORT_ROWS)}. Filtre el reporte antes de exportarlo.`
        : `El reporte son ${es(rows)} filas × ${columns} columnas = ${es(cells)} celdas, ` +
          `y el máximo por ${what} es ${es(cellLimit)}. Quite columnas o filtre filas.`,
    );
    this.name = "ExportTooLargeError";
  }
}

/** True when the report does not fit in one file of this format. */
export function exceedsExportLimits(rows: number, columns: number, format: ExportFormat): boolean {
  return rows > MAX_EXPORT_ROWS || rows * columns > MAX_EXPORT_CELLS[format];
}

export interface ExportRequest {
  config: ReportConfig;
  role: number;
  format: ExportFormat;
  title: string;
  subtitle?: string | null;
  /** Ignored for PDF: two thousand photographs in a tabular document are unreadable. */
  photos?: boolean;
}

export interface ExportOutput {
  filename: string;
  contentType: string;
  buffer: Buffer;
  rows: number;
  photos: Omit<LoadedPhotos, "images"> | null;
}

export async function buildExport(request: ExportRequest): Promise<ExportOutput> {
  const { config, role, format } = request;

  // Validate before measuring. A count query does not need the columns, so it
  // never looks at them: a report naming a field that does not exist came back
  // as "too many cells" whenever it also happened to be large, sending the user
  // to delete columns that were not the problem. The call is a pure string
  // build and its result is deliberately discarded.
  buildQuery(config, role);

  // Then size, so an oversized report is refused before its rows are read.
  // Materialising twenty thousand rows only to reject them is exactly the
  // memory the limit exists to protect.
  const total = await countReport(config, role);
  const width = Array.isArray(config.columns) ? config.columns.length : 0;
  if (exceedsExportLimits(total, width, format)) {
    throw new ExportTooLargeError(total, width, format);
  }

  const result = await runReport({ ...config, offset: 0, limit: MAX_EXPORT_ROWS }, role);
  // Grouping changes what a row is, so the root's noun stops being true: over a
  // report grouped by tramo it said "89 eventos" about 89 tramos. `catalogView`
  // states the rule and this call ignored it. "grupos" is less informative than
  // naming the entity, and it has the advantage of never being a lie — the
  // table underneath carries the detail.
  const noun = (config.groupBy?.length ?? 0) > 0 ? "grupos" : rowNoun(config.root);
  const title = request.title.trim() || "Reporte";
  const subtitle = request.subtitle?.trim() || null;

  if (format === "pdf") {
    return {
      filename: reportFileName(title, "pdf"),
      contentType: CONTENT_TYPE.pdf,
      buffer: await buildPdf({ columns: result.columns, rows: result.rows, title, subtitle, noun }),
      rows: result.rows.length,
      photos: null,
    };
  }

  let photos: LoadedPhotos | null = null;
  if (request.photos) {
    const imageKeys = result.columns.filter((c) => c.kind === "image").map((c) => c.key);
    if (imageKeys.length > 0) {
      const values = result.rows.flatMap((row) => imageKeys.map((key) => row[key]));
      photos = await loadPhotos(values, { cap: MAX_EXPORT_PHOTOS });
    }
  }

  return {
    filename: reportFileName(title, "xlsx"),
    contentType: CONTENT_TYPE.excel,
    buffer: await buildExcel({
      columns: result.columns, rows: result.rows, title, subtitle, noun, photos,
    }),
    rows: result.rows.length,
    // `failed` travels with the rest: the bitácora is where anyone asks later
    // why an export came back without its photographs.
    photos: photos && {
      requested: photos.requested,
      loaded: photos.loaded,
      skipped: photos.skipped,
      failed: photos.failed,
    },
  };
}
