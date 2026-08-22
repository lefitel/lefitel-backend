import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import { sequelize } from "../../database/sequelize.js";
import {
  buildExport, exceedsExportLimits, exceedsExportWeight, ExportCanceledError,
  ExportTooHeavyError, ExportTooLargeError, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS,
} from "./index.js";
import { exportSlot } from "./queue.js";
import type { ReportConfig } from "../types.js";
import type { Viewer } from "../viewer.js";

/**
 * Against the real database, which is where the pieces meet: the query engine,
 * the semantics the catalog publishes, and the two builders. Skipped when no
 * database answers, like the other regression tests.
 */
const dbAvailable = await sequelize
  .authenticate()
  .then(() => true)
  .catch(() => false);

const ADMIN: Viewer = { role: 1, staff: true };

/** The columns the fixed "General" report shows, expressed as a configuration. */
const generalConfig: ReportConfig = {
  root: "evento",
  columns: [
    { path: "poste.name", label: "Nº Poste" },
    { path: "poste.propietario.name", label: "Propietario" },
    { path: "description", label: "Descripción" },
    // Severity is calculated from the event's observations, not stored on it.
    { path: "criticidad", label: "Criticidad" },
    { path: "state", label: "Resuelto" },
    { path: "date", label: "Fecha" },
  ],
  limit: 200,
};

describe.skipIf(!dbAvailable)("buildExport against real data", () => {
  it("produces a spreadsheet whose strip counts what the rows say", async () => {
    const output = await buildExport({
      config: generalConfig, viewer: ADMIN, format: "excel", title: "Reporte general",
    });

    expect(output.filename).toMatch(/^Reporte general_.+\.xlsx$/);
    expect(output.contentType).toContain("spreadsheetml");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output.buffer as never);
    const sheet = workbook.worksheets[0];

    // The header block is fixed; the data begins on row 5.
    expect(sheet.getCell(1, 1).value).toBe("Reporte general");
    expect(sheet.rowCount).toBe(4 + output.rows);

    const strip = (sheet.getCell(3, 1).value as ExcelJS.CellRichTextValue)
      .richText.map((run) => run.text).join("");
    expect(strip).toContain(`${output.rows.toLocaleString("es-BO")} eventos`);
    expect(strip).toContain("resueltos");
    expect(strip).toContain("críticos");
  });

  it("counts resolved and pending against the rows it actually wrote", async () => {
    const output = await buildExport({
      config: generalConfig, viewer: ADMIN, format: "excel", title: "Cuadre",
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output.buffer as never);
    const sheet = workbook.worksheets[0];

    // Column 5 is "Resuelto"; recount it from the sheet itself.
    let resolved = 0;
    for (let row = 5; row < 5 + output.rows; row++) {
      if (sheet.getCell(row, 5).value === "Sí") resolved += 1;
    }
    const strip = (sheet.getCell(3, 1).value as ExcelJS.CellRichTextValue)
      .richText.map((run) => run.text).join("");

    expect(strip).toContain(`${resolved.toLocaleString("es-BO")} resueltos`);
    expect(strip).toContain(`${(output.rows - resolved).toLocaleString("es-BO")} pendientes`);
  });

  it("names the rows for what they are once the report is grouped", async () => {
    // Grouped by tramo a row is a tramo, and the strip has to say so.
    const output = await buildExport({
      config: {
        root: "evento",
        columns: [
          { path: "poste.tramo", label: "Tramo" },
          { path: "id", agg: "count", label: "Eventos" },
        ],
        groupBy: ["poste.tramo"],
        limit: 500,
      },
      viewer: ADMIN, format: "excel", title: "Por tramo",
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output.buffer as never);
    const strip = (workbook.worksheets[0].getCell(3, 1).value as ExcelJS.CellRichTextValue)
      .richText.map((run) => run.text).join("");

    // Eighty-nine rows, and each one is a tramo. Saying "89 eventos" — which
    // this test used to require — is false twice over: they are not events, and
    // there are 1.376 of those. The count has to describe what is on the page.
    expect(strip).toMatch(/^89 grupos$/);
    expect(strip).not.toContain("eventos");
    // An aggregate loses its meaning, so nothing pretends to be a state here.
    expect(strip).not.toContain("resueltos");
  });

  it("does not read a group key as if it were a record's state", async () => {
    // Grouped by state there are two rows, one per value. Reading the group key
    // per row counted groups and printed "2 eventos · 1 resueltos · 1
    // pendientes" over a report whose truth was 1.376, 938 and 438 — the
    // headline of a management report, wrong by three orders of magnitude.
    const output = await buildExport({
      config: {
        root: "evento",
        columns: [
          { path: "state", label: "Resuelto" },
          { path: "id", agg: "count", label: "Eventos" },
        ],
        groupBy: ["state"],
        limit: 500,
      },
      viewer: ADMIN, format: "excel", title: "Por estado",
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output.buffer as never);
    const strip = (workbook.worksheets[0].getCell(3, 1).value as ExcelJS.CellRichTextValue)
      .richText.map((run) => run.text).join("");

    expect(strip).not.toContain("resueltos");
    expect(strip).not.toContain("pendientes");
  });

  it("produces a document from the same configuration", async () => {
    const output = await buildExport({
      config: generalConfig, viewer: ADMIN, format: "pdf", title: "Reporte general",
    });

    expect(output.filename).toMatch(/\.pdf$/);
    expect(output.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(output.photos).toBeNull();
  });

  it("refuses a report larger than one file can hold", async () => {
    // The cap counts cells, so the same rows fit or do not depending on width.
    // These two configurations differ only in that, which is what makes the
    // pair worth having: the wide one must be refused and the narrow one must
    // succeed. Asserting only that something succeeds would pass with the
    // check deleted, which is what this test used to do.
    const wide = (count: number): ReportConfig => ({
      root: "revision",
      columns: Array.from({ length: count }, () => ({ path: "id" })),
      limit: MAX_EXPORT_ROWS,
    });

    await expect(
      buildExport({ config: wide(60), viewer: ADMIN, format: "pdf", title: "Todas" }),
    ).rejects.toThrow(ExportTooLargeError);

    await expect(
      buildExport({ config: wide(5), viewer: ADMIN, format: "pdf", title: "Todas" }),
    ).resolves.toBeTruthy();
    // Vitest's five seconds are for unit tests. The narrow case has to actually
    // render every revision in the database to a PDF — measured at ~11s, of
    // which the query is 98ms and the rest is the PDF writer. Left at the
    // default this fails on a slow afternoon and says nothing about the code.
  }, 40_000);

  it("says so when the photographs it was asked for are not on this machine", async () => {
    // Development has seventeen images; the database references production file
    // names. Every miss degrades to "Sí" rather than to an error — that part
    // was right, and this test used to assert only that the call resolved and
    // the file was over a kilobyte. It never read a cell, so it passed just as
    // happily over a workbook that promised 1.376 photographs and contained
    // none, with nothing anywhere saying they were missing. A file that
    // silently omits what was asked for is worse than one that refuses.
    const output = await buildExport({
      config: {
        root: "evento",
        columns: [{ path: "poste.name" }, { path: "image", label: "Foto" }],
        limit: 50,
      },
      viewer: ADMIN, format: "excel", title: "Con fotos", photos: true,
    });

    expect(output.photos).not.toBeNull();
    expect(output.photos!.requested).toBeGreaterThan(0);

    // Nothing evaporates: every photograph asked for is either in the file,
    // over the cap, or counted as unreadable.
    const { requested, loaded, skipped, failed } = output.photos!;
    expect(loaded + skipped + failed).toBe(requested);

    // And when any are missing, the workbook itself says so.
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(output.buffer as unknown as ArrayBuffer);
    const subtitle = String(book.worksheets[0].getCell(2, 1).text);

    if (failed > 0) expect(subtitle).toContain(`SIN ${failed} FOTOGRAFÍA(S)`);
    else expect(subtitle).not.toContain("no se encontraron");
  });

  it("rejects a configuration the engine will not accept", async () => {
    await expect(
      buildExport({
        config: { root: "no_existe", columns: [{ path: "id" }] },
        viewer: ADMIN, format: "excel", title: "Malo",
      }),
    ).rejects.toThrow();
  });

  it("blames the bad column, not the size, when both are wrong", async () => {
    // A count query never looks at the columns, so a large report naming a
    // field that does not exist used to come back as "too many cells" and send
    // the user to delete columns that were not the problem.
    const paths = [
      "id", "date", "description", "evento.description", "evento.state", "evento.date",
      "evento.poste.name", "evento.poste.lat", "evento.poste.lng",
      "evento.poste.propietario.name", "no_existe_1", "no_existe_2",
    ];

    await expect(
      buildExport({
        config: { root: "revision", columns: paths.map((path) => ({ path })), limit: 20000 },
        viewer: ADMIN, format: "pdf", title: "Grande y mal",
      }),
    ).rejects.toThrow(/no existe en el catálogo/);
  });
});

describe("export limits", () => {
  it("lets through what actually fits", () => {
    // Fisher's general report is about 1.376 rows and 11 columns.
    expect(exceedsExportLimits(1_376, 11, "excel")).toBe(false);
    expect(exceedsExportLimits(1_376, 11, "pdf")).toBe(false);
    expect(exceedsExportLimits(20_000, 10, "excel")).toBe(false);
  });

  it("stops a report that is too tall whatever its width", () => {
    expect(exceedsExportLimits(20_001, 1, "excel")).toBe(true);
    expect(exceedsExportLimits(20_001, 1, "pdf")).toBe(true);
  });

  it("stops a report that is too wide even when it is short", () => {
    // Measured: 5.000 × 40 costs the same 475 MB as 20.000 × 10. Cells, not rows.
    expect(exceedsExportLimits(5_000, 41, "excel")).toBe(true);
    expect(exceedsExportLimits(5_000, 40, "excel")).toBe(false);
  });

  it("holds the document to what a person can receive", () => {
    // A PDF costs about 0,3 MB per thousand cells; 80.000 is roughly 25 MB,
    // which is the largest attachment most mail servers accept.
    expect(exceedsExportLimits(10_000, 10, "pdf")).toBe(true);
    expect(exceedsExportLimits(8_000, 10, "pdf")).toBe(false);
    // The same report fits comfortably as a spreadsheet.
    expect(exceedsExportLimits(10_000, 10, "excel")).toBe(false);
  });
});

describe("ExportTooLargeError", () => {
  it("names the row limit when the report is simply too tall", () => {
    const error = new ExportTooLargeError(50_000, 4, "excel");

    expect(error.message).toContain("50.000");
    expect(error.message).toContain("20.000");
    expect(error.message).toContain("Filtre");
  });

  it("names both levers when it is the shape that does not fit", () => {
    // Telling someone with sixty columns to "filter rows" sends them to fix
    // the wrong thing.
    const error = new ExportTooLargeError(5_000, 60, "excel");

    expect(error.message).toContain("5.000 filas × 60 columnas");
    expect(error.message).toContain("300.000 celdas");
    expect(error.message).toContain("200.000");
    expect(error.message).toMatch(/Quite columnas o filtre filas/);
  });

  it("says which format it could not fit into", () => {
    expect(new ExportTooLargeError(10_000, 10, "pdf").message).toContain("documento");
    expect(new ExportTooLargeError(10_000, 30, "excel").message).toContain("hoja de cálculo");
  });
});

describe("what an export refuses, and when it gives up", () => {
  it("stops when the caller has hung up, and gives the slot back", async () => {
    // Cancelling used to cancel nothing: the browser dropped the request and the
    // server kept building a file for nobody while holding the only export slot
    // in the process. The next person was told "ya hay una exportación en curso"
    // about their own abandoned one.
    const abandoned = AbortSignal.abort();

    await expect(
      exportSlot.run(() =>
        buildExport({
          config: generalConfig, viewer: ADMIN, format: "excel", title: "Abandonado",
          signal: abandoned,
        }),
      ),
    ).rejects.toBeInstanceOf(ExportCanceledError);

    // The point of the whole thing: the next export is not refused.
    expect(exportSlot.isBusy).toBe(false);
  });

  it("counts the report once, in the same read the rows come from", async () => {
    // Two counts per export: one to decide whether the file could be built and
    // one inside `runReport`, in two separate transactions. So the number the
    // decision was made on came from a different snapshot than the rows that
    // went into the file — under a concurrent insert the header said one figure
    // and the sheet held another — and every export paid for planning the same
    // aggregate twice.
    const spy = vi.spyOn(sequelize, "query");
    try {
      await buildExport({
        config: { ...generalConfig, limit: 50 }, viewer: ADMIN, format: "excel",
        title: "Un solo conteo",
      });

      const counts = spy.mock.calls.filter(([sql]) =>
        typeof sql === "string" && sql.includes("COUNT(*)::int AS total"),
      );
      expect(counts).toHaveLength(1);

      // And in one transaction, so the count and the rows share a snapshot.
      const transactions = new Set(
        spy.mock.calls
          .map(([, options]) => (options as { transaction?: unknown } | undefined)?.transaction)
          .filter(Boolean),
      );
      expect(transactions.size).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("weighs the file instead of inferring its weight from its shape", () => {
    // The cell caps are justified in megabytes — "80.000 celdas son unos 25 MB,
    // el adjunto más grande que acepta la mayoría de los servidores de correo" —
    // and cells only predict megabytes while the cells are small. The same
    // 80.000 with long text columns came out at 32,9 MB, a third over the limit
    // the cap exists to respect, and nothing was measuring it.
    expect(exceedsExportWeight(MAX_EXPORT_BYTES)).toBe(false);
    expect(exceedsExportWeight(MAX_EXPORT_BYTES + 1)).toBe(true);
    expect(exceedsExportWeight(Math.round(32.9 * 1024 * 1024))).toBe(true);

    // And the message names the two numbers and the lever, like its sibling.
    const message = new ExportTooHeavyError(Math.round(32.9 * 1024 * 1024), "pdf").message;
    expect(message).toContain("32.9 MB");
    expect(message).toContain("25.0 MB");
    expect(message).toMatch(/texto largo|filtre/);
  });
});
