// One table, three files.
//
// The nine export buttons on the pole, incident and user screens used to build
// their file in the browser: the same two hundred lines copied into three
// components, and copies drift. An audit of them before this module existed
// found the incident PDF drawing its footer at millimetre 212 of a 210 mm page
// — no page numbers on any page, in a document that goes to a client — the pole
// PDF still carrying column widths for a layout that had lost a column, and the
// same CSV escaper in all three refusing to defend against the one thing a CSV
// escaper is for.
//
// So: one place. The spreadsheet and the document are the report generator's
// own builders, because a second implementation of "a table with the company
// band on top" is how the first pair drifted. The CSV is written here, because
// the generator has never had one.
//
// **What this module is not.** It does not know where rows come from, what the
// user may see, or how many rows are too many for the person waiting. It
// receives a finished table. Every caller resolves its own columns, its own
// permission and its own filters, and three of them do — see the `exportar*`
// handlers in the pole, incident and user controllers.

import type { Response } from "express";
import { buildExcel } from "../reportBuilder/export/excel.js";
import { buildPdf } from "../reportBuilder/export/pdf.js";
import {
  exceedsExportWeight,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_ROWS,
} from "../reportBuilder/export/index.js";
import { ExportBusyError } from "../reportBuilder/export/queue.js";
import { formatValue, reportFileName } from "../reportBuilder/export/values.js";
import type { FieldKind, FieldSemantic, ResultColumn } from "../reportBuilder/types.js";

export type Formato = "excel" | "csv" | "pdf";

/** The only three values `format` accepts, and the order the menu lists them. */
export const FORMATOS: readonly Formato[] = ["excel", "csv", "pdf"] as const;

export const esFormato = (valor: unknown): valor is Formato =>
  FORMATOS.includes(valor as Formato);

/**
 * The line under the title, saying what the file is a subset of.
 *
 * A file built from a filtered screen and one built from the whole table are
 * otherwise the same document making two different claims, and the reader
 * cannot tell them apart — which is exactly how a spreadsheet holding four of
 * 1.514 incidents goes to a client titled "Incidencias del Sistema". So the
 * filters are written into the document itself, in the words the screen uses.
 */
export const subtituloDeFiltros = (partes: readonly string[]): string =>
  partes.length === 0 ? "Listado completo" : `Filtrado por ${partes.join(" · ")}`;

/**
 * One column of the table.
 *
 * `ResultColumn` minus `path` and `agg`. Both are required by that type and
 * neither is read by either builder — `path` exists so the report screen can
 * sort by clicking a header, and there is no such screen here. The synthesis
 * happens once, below, rather than at three call sites inventing a path each.
 *
 * `semantic` is what tints the rows: a `state` column turns resolved rows
 * green, a `criticality` column shades the rest by severity. **It only works on
 * a column that is printed** — `rowStyleKeys` looks for it among the columns
 * the sheet is about to draw, so there is no way to colour by a hidden value.
 * A caller that wants the colour has to show the column.
 */
export interface Columna {
  key: string;
  label: string;
  kind: FieldKind;
  semantic?: FieldSemantic;
}

export interface Peticion {
  formato: Formato;
  columnas: readonly Columna[];
  /** Values keyed by `Columna.key`. Raw: dates as dates, numbers as numbers. */
  filas: readonly Record<string, unknown>[];
  /** Printed at the top of the file, and the base of its name. */
  titulo: string;
  /**
   * The line under the title. This is where a caller says what the file is a
   * subset *of*: a file built from a filtered screen and one built from the
   * whole table are otherwise identical documents making different claims.
   */
  subtitulo?: string | null;
  /**
   * Singular and plural, in that order.
   *
   * Both, because the indicator strip counts the rows and a strip that reads
   * "1 usuarios" is the kind of detail that makes a reader distrust the rest of
   * the numbers. The generator resolves this in a layer this module does not
   * use, so it is resolved here.
   */
  sustantivo: readonly [string, string];
  /** The spreadsheet's tab. Without it every sheet is called "Reporte". */
  hoja: string;
}

export interface Fichero {
  buffer: Buffer;
  contentType: string;
  filename: string;
  filas: number;
}

/**
 * Thrown when the table is too big to build, or the built file too heavy.
 *
 * Separate from the listing's own ceiling on purpose. `MAX_LIST_ROWS` governs
 * `limit=all` and answers "pida la lista por páginas", which is advice nobody
 * can follow while downloading a file. This one says what it means.
 */
export class ExportExcedidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportExcedidoError";
  }
}

const CONTENT_TYPE: Record<Formato, string> = {
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
};

const EXTENSION: Record<Formato, string> = { excel: "xlsx", csv: "csv", pdf: "pdf" };

/**
 * Cells, not rows, because a wide table costs what a tall one does.
 *
 * The two borrowed numbers are the generator's, measured there and documented
 * beside the table that produced them. CSV gets the spreadsheet's ceiling: it
 * is text with no object model behind it, so it is the cheapest of the three by
 * a wide margin and nothing is gained by stopping it sooner.
 */
const MAX_CELDAS: Record<Formato, number> = { excel: 200_000, csv: 200_000, pdf: 80_000 };

const es = (n: number) => n.toLocaleString("es-BO");

/**
 * Text where the spreadsheet would put a typed value.
 *
 * `formatValue` is the generator's, and using it is the point: dates render in
 * the report's own time zone rather than in whatever zone the machine building
 * the file happens to sit in. That was a real defect in the browser version —
 * a pole registered in La Paz at midnight came out a day earlier for anyone
 * exporting from a different zone, so two people exporting the same row on the
 * same day got different files.
 *
 * Two departures, both because a CSV is read by programs at least as often as
 * by people:
 *
 * - **An absent value is an empty cell**, not `formatValue`'s "—". A dash is a
 *   reasonable thing to show a reader and a string that is not the data.
 * - **Numbers keep the decimal point.** `formatValue` renders 16.5 as "16,5",
 *   which is how a Bolivian reader writes it and, in this file, a decimal
 *   separator colliding with the field separator: the value survives only
 *   because it ends up quoted, and every consumer then has to know which comma
 *   is which. The browser exporter wrote "-16.5" and so does this. The comma
 *   stays where it belongs, in the spreadsheet and the document, where a cell
 *   is a value and not a substring.
 */
const textoCsv = (valor: unknown, kind: FieldKind): string => {
  if (valor === null || valor === undefined || valor === "") return "";
  if (kind === "number") {
    const n = Number(valor);
    return Number.isFinite(n) ? String(n) : String(valor);
  }
  return formatValue(valor, kind);
};

/**
 * The characters that make a spreadsheet treat a cell as a formula, not as text.
 *
 * `-` is on the list and it is the awkward one, because every negative number
 * starts with it. Bolivia sits west of Greenwich and south of the equator, so
 * **every** latitude and longitude in this database is negative: defending them
 * would turn each coordinate into text and cost the reader the ability to sort
 * or compute with the column — a certain loss, to prevent an impossible attack,
 * since a number is rendered by `textoCsv` and cannot carry a payload. So the
 * guard applies to text columns and only to text columns, which is where the
 * user-typed values are.
 */
const PELIGROSO = /^[=+\-@\t\r]/;

/**
 * One CSV cell, quoted and defused.
 *
 * **What the apostrophe costs, said plainly.** It is consumed on open by Excel
 * and LibreOffice, which is where these files are read, and it is *not* by
 * Google Sheets or by any CSV parser — and this same module argues, two
 * paragraphs up, that a CSV is read by programs as often as by people. Both
 * cannot be free. A description beginning with a hyphen, which is an ordinary
 * way to write one, leaves here as `'- Cambio de ferretería`. The trade is
 * still worth taking: without the apostrophe that same cell renders in Excel as
 * `#¡NOMBRE?`, so the choice is not "clean or dirty" but "a leading apostrophe
 * a program has to strip" against "a value no reader can see at all".
 *
 * The browser version quoted commas, quotation marks and newlines, and stopped
 * there. That left two holes, one of which is not theoretical: a phone number
 * written `+59170000000` — the only way to write a Bolivian number — arrives in
 * Excel as a formula and displays as `#¡NOMBRE?`. The user directory has been
 * exporting broken phone columns for as long as the button has existed.
 *
 * The other hole is the reason this function has a test of its own. Names and
 * descriptions are free text typed by users, so a pole called
 * `=HYPERLINK("http://…"&A1,"ver")` executes in the spreadsheet of whoever
 * opens the file — a person who is usually not the person who typed it, and is
 * often the client. The leading apostrophe is what tells a spreadsheet "this is
 * text"; it is consumed on open and does not show.
 */
export const celdaCsv = (valor: string, defender: boolean): string => {
  const seguro = defender && PELIGROSO.test(valor) ? `'${valor}` : valor;
  // Quoted whenever it was defused, as well as when it has to be: the leading
  // apostrophe is only read as "this is text" inside a quoted field.
  return /["\n\r,;]/.test(seguro) || seguro !== valor
    ? `"${seguro.replace(/"/g, '""')}"`
    : seguro;
};

const construirCsv = (columnas: readonly Columna[], filas: readonly Record<string, unknown>[]): Buffer => {
  const lineas = [
    columnas.map((c) => celdaCsv(c.label, false)).join(","),
    ...filas.map((fila) =>
      columnas.map((c) => celdaCsv(textoCsv(fila[c.key], c.kind), c.kind === "string")).join(",")),
  ];
  // The BOM is what makes Excel open a UTF-8 CSV as UTF-8; without it every
  // accent in the file is mojibake on a Spanish Windows. CRLF for the same
  // reason: it is what the readers on that platform expect.
  return Buffer.from(`\uFEFF${lineas.join("\r\n")}\r\n`, "utf8");
};

/** `Columna` as the builders want it. Neither reads `path`; the type wants one. */
const comoResultColumn = (c: Columna): ResultColumn => ({
  key: c.key,
  label: c.label,
  kind: c.kind,
  ...(c.semantic ? { semantic: c.semantic } : {}),
  path: c.key,
});

/**
 * Builds the file, or refuses with a sentence the person waiting can act on.
 *
 * The weight check runs on the finished file rather than on a prediction of it,
 * for the reason the generator documents where `MAX_EXPORT_BYTES` is defined:
 * cells only predict weight while the cells are small, and the case where the
 * prediction is wrong is exactly the case the limit exists for.
 */
export async function construirFichero(peticion: Peticion): Promise<Fichero> {
  const { formato, columnas, filas, titulo, hoja } = peticion;

  if (filas.length > MAX_EXPORT_ROWS) {
    // "Supera las 20.000" and not "tiene 20.001": every caller reads one row
    // over the ceiling on purpose, so an exact count here would be the same
    // number for a table of twenty thousand and one and for one of four hundred
    // thousand. A true count is a second query for a sentence nobody acts on.
    throw new ExportExcedidoError(
      `La exportación supera las ${es(MAX_EXPORT_ROWS)} filas. Filtre la lista antes de exportarla.`,
    );
  }
  const celdas = filas.length * columnas.length;
  if (celdas > MAX_CELDAS[formato]) {
    throw new ExportExcedidoError(
      `La exportación tiene ${es(celdas)} celdas y el máximo para este formato es ` +
      `${es(MAX_CELDAS[formato])}. Filtre la lista antes de exportarla.`,
    );
  }

  const noun = peticion.sustantivo[filas.length === 1 ? 0 : 1];
  const columns = columnas.map(comoResultColumn);

  const buffer =
    formato === "csv" ? construirCsv(columnas, filas)
      : formato === "excel"
        ? await buildExcel({ columns, rows: filas, title: titulo, subtitle: peticion.subtitulo ?? null, noun, sheetName: hoja })
        : await buildPdf({ columns, rows: filas, title: titulo, subtitle: peticion.subtitulo ?? null, noun });

  if (exceedsExportWeight(buffer.length)) {
    throw new ExportExcedidoError(
      `El fichero pesa ${(buffer.length / (1024 * 1024)).toFixed(1)} MB y el máximo es ` +
      `${MAX_EXPORT_BYTES / (1024 * 1024)} MB. Filtre la lista antes de exportarla.`,
    );
  }

  return {
    buffer,
    contentType: CONTENT_TYPE[formato],
    filename: reportFileName(titulo, EXTENSION[formato]),
    filas: filas.length,
  };
}

// ── Answering with it ────────────────────────────────────────────────────────

/**
 * Sends the file, named so that the browser keeps the name and the accents.
 *
 * Both forms of the name: the percent-encoded one so "Reporte de Incidencias"
 * survives, and a plain ASCII one for anything that ignores RFC 5987. The
 * header only reaches the browser because `app.ts` lists it in the CORS
 * `exposedHeaders` — without that every download is called "download".
 *
 * `no-store` for the same reason the six fixed reports carry it: this is a
 * register of a company's assets leaving the system through a GET-shaped
 * response, and the difference between "probably nobody keeps a copy" and
 * "nobody may" is one header.
 */
export const responderFichero = (res: Response, fichero: Fichero): void => {
  res.setHeader("Content-Type", fichero.contentType);
  res.setHeader("Content-Length", fichero.buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fichero.filename.replace(/[^\x20-\x7e]/g, "_")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(fichero.filename)}`,
  );
  res.status(200).send(fichero.buffer);
};

/**
 * Answers the two failures an export has that a listing does not, or says it
 * did not recognise this one so the caller can let it become a 500.
 *
 * Both carry a sentence written for the person waiting, which is why they are
 * answered rather than logged: "the file would weigh 40 MB" and "somebody
 * else's export is running" are things a user can act on, and a neutral 500 is
 * not. Same statuses the report generator already uses for the same two.
 */
export const responderFalloDeExport = (res: Response, error: unknown): boolean => {
  if (error instanceof ExportExcedidoError) {
    res.status(413).json({ message: error.message });
    return true;
  }
  if (error instanceof ExportBusyError) {
    res.status(429).json({ message: error.message });
    return true;
  }
  return false;
};
