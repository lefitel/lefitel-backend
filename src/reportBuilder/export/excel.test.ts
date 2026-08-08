import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildExcel, type ExcelInput } from "./excel.js";
import { RESOLVED_HEX, CRITICALITY_HEX, BAND_HEX } from "./rowStyle.js";
import type { ResultColumn } from "../types.js";
import type { LoadedPhotos } from "./photos.js";

const column = (over: Partial<ResultColumn> & { key: string }): ResultColumn => ({
  label: over.key,
  kind: "string",
  ...over,
});

/** Reads the produced file back, which is the only proof it is a real workbook. */
async function readBack(input: ExcelInput): Promise<ExcelJS.Worksheet> {
  const buffer = await buildExcel(input);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook.worksheets[0];
}

const fillOf = (cell: ExcelJS.Cell): string | undefined =>
  (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;

const base: ExcelInput = {
  columns: [
    column({ key: "c0", label: "Descripción" }),
    column({ key: "c1", label: "Fecha", kind: "date" }),
    column({ key: "c2", label: "Gravedad", kind: "number", semantic: "criticality" }),
    column({ key: "c3", label: "Cerrado", kind: "boolean", semantic: "state" }),
  ],
  rows: [
    { c0: "Poste inclinado", c1: "2026-03-15T02:00:00.000Z", c2: 1, c3: false },
    { c0: "Vano bajo", c1: null, c2: 5, c3: true },
    { c0: null, c1: "2026-01-02T18:00:00.000Z", c2: null, c3: false },
  ],
  title: "Eventos de marzo",
  subtitle: "Una fila por evento",
  noun: "eventos",
};

describe("buildExcel", () => {
  it("produces a workbook that opens", async () => {
    const sheet = await readBack(base);

    expect(sheet.name).toBe("Reporte");
    expect(sheet.getCell(1, 1).value).toBe("Eventos de marzo");
  });

  it("freezes everything above the data", async () => {
    const sheet = await readBack(base);

    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
  });

  it("writes the indicator strip from the meaning of the columns", async () => {
    const sheet = await readBack(base);
    const strip = sheet.getCell(3, 1).value as ExcelJS.CellRichTextValue;

    const text = strip.richText.map((run) => run.text).join("");
    expect(text).toContain("3 eventos");
    expect(text).toContain("1 resueltos");
    expect(text).toContain("2 pendientes");
    expect(text).toContain("1 críticos");
  });

  it("names the rows with the noun it is given", async () => {
    // Grouped by tramo, a row is a tramo. Saying "eventos" would be a lie the
    // reader has no way of catching.
    const sheet = await readBack({ ...base, noun: "tramos" });
    const strip = sheet.getCell(3, 1).value as ExcelJS.CellRichTextValue;

    expect(strip.richText.map((r) => r.text).join("")).toContain("3 tramos");
  });

  it("shows only the total when nothing declares a meaning", async () => {
    const sheet = await readBack({
      ...base,
      columns: [column({ key: "c0", label: "Descripción" })],
      rows: [{ c0: "a" }],
    });
    const strip = sheet.getCell(3, 1).value as ExcelJS.CellRichTextValue;

    const text = strip.richText.map((r) => r.text).join("");
    expect(text).toContain("1 eventos");
    expect(text).not.toContain("resueltos");
  });

  it("puts the headers where the data can be filtered", async () => {
    const sheet = await readBack(base);

    expect(sheet.getCell(4, 1).value).toBe("Descripción");
    // A re-read workbook reports the range as a string, not as the object the
    // builder handed in: four columns of headers on row 4.
    expect(sheet.autoFilter).toBe("A4:D4");
  });

  it("colours a resolved row green whatever its severity", async () => {
    const sheet = await readBack(base);

    // Row 6 is the second data row: resolved, severity 5.
    expect(fillOf(sheet.getCell(6, 1))).toBe(`FF${RESOLVED_HEX}`);
  });

  it("colours an unresolved row by severity", async () => {
    const sheet = await readBack(base);

    expect(fillOf(sheet.getCell(5, 1))).toBe(`FF${CRITICALITY_HEX[1]}`);
  });

  it("bands a row with neither state nor severity", async () => {
    const sheet = await readBack({
      ...base,
      columns: [column({ key: "c0", label: "Descripción" })],
      rows: [{ c0: "a" }, { c0: "b" }],
    });

    expect(fillOf(sheet.getCell(5, 1))).toBeUndefined();
    expect(fillOf(sheet.getCell(6, 1))).toBe(`FF${BAND_HEX}`);
  });

  it("keeps dates and numbers native so the reader can sort them", async () => {
    const sheet = await readBack(base);

    expect(sheet.getCell(5, 2).value).toBeInstanceOf(Date);
    expect(sheet.getCell(5, 3).value).toBe(1);
    expect(sheet.getCell(5, 2).numFmt).toBe("dd/mm/yyyy");
  });

  it("writes the date of the report's zone, not the server's", async () => {
    // 02:00 UTC is the previous day in La Paz. The spreadsheet said 15/03 while
    // the preview said 14/03 — one report, two dates.
    const sheet = await readBack(base);
    const value = sheet.getCell(5, 2).value as Date;

    expect(value.getUTCDate()).toBe(14);
  });

  it("leaves an empty value as an empty cell", async () => {
    const sheet = await readBack(base);

    expect(sheet.getCell(6, 2).value).toBeNull();
    expect(sheet.getCell(7, 1).value).toBeNull();
  });

  it("gives every data row an explicit height", async () => {
    // Without one, wrapText grows a row to Excel's 409-point maximum.
    const sheet = await readBack(base);

    expect(sheet.getRow(5).height).toBe(30);
  });

  it("survives a report with no rows", async () => {
    const sheet = await readBack({ ...base, rows: [] });

    expect(sheet.getCell(4, 1).value).toBe("Descripción");
    expect(sheet.autoFilter).toBeFalsy();
  });

  it("survives a single column", async () => {
    const sheet = await readBack({
      ...base,
      columns: [column({ key: "c0", label: "Solo" })],
      rows: [{ c0: "x" }],
    });

    expect(sheet.getCell(4, 1).value).toBe("Solo");
  });

  it("trims a value longer than a cell can hold", async () => {
    const sheet = await readBack({
      ...base,
      columns: [column({ key: "c0", label: "Larga" })],
      rows: [{ c0: "x".repeat(40_000) }],
    });

    expect(String(sheet.getCell(5, 1).value)).toHaveLength(32_767);
  });

  it("keeps a non-finite number as text instead of damaging the file", async () => {
    const sheet = await readBack({
      ...base,
      columns: [column({ key: "c0", label: "N", kind: "number" })],
      rows: [{ c0: "1e400" }],
    });

    expect(sheet.getCell(5, 1).value).toBe("1e400");
  });
});

describe("buildExcel with photographs", () => {
  const photoColumns = [
    column({ key: "c0", label: "Poste" }),
    column({ key: "foto", label: "Foto del evento", kind: "image" }),
  ];
  const photoRows = [{ c0: "P-1", foto: "/uno.webp" }, { c0: "P-2", foto: "/dos.webp" }];

  const loaded = (over: Partial<LoadedPhotos> = {}): LoadedPhotos => ({
    images: new Map([["/uno.webp", Buffer.from("no-es-un-jpeg-real")]]),
    requested: 2, loaded: 1, skipped: 0,
    ...over,
  });

  it("embeds the photograph it has and falls back for the one it lacks", async () => {
    const buffer = await buildExcel({
      ...base, columns: photoColumns, rows: photoRows, photos: loaded(),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0];

    // Exactly one drawing for the photograph plus one for the Osefi logo. Tigo
    // is skipped because this fixture is two columns wide. The count has to be
    // exact: `>= 1` is satisfied by the logo alone, so it passed with photo
    // embedding removed entirely.
    expect(sheet.getImages().length).toBe(2);
    // The row without an image says so; it never writes the stored path, which
    // would be a publicly fetchable URL.
    expect(sheet.getCell(6, 2).value).toBe("Sí");
  });

  it("stores one copy of a photograph however many rows show it", async () => {
    // ExcelJS does not deduplicate: `addImage` pushes and returns a new id every
    // call. Called once per row, a report where rows share a photograph carried
    // one copy of the JPEG per row — 38,6 MB and 425 MB of RSS on the live data
    // where 0,12 MB was enough.
    const shared = Buffer.from("no-es-un-jpeg-real");
    const manyRows = Array.from({ length: 20 }, (_, i) => ({ c0: `P-${i}`, foto: "/uno.webp" }));

    const buffer = await buildExcel({
      ...base,
      columns: photoColumns,
      rows: manyRows,
      photos: { images: new Map([["/uno.webp", shared]]), requested: 20, loaded: 20, skipped: 0 },
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    // Twenty-one drawings on the sheet — one per row, plus the logo — but only
    // two images in the workbook. That gap is the whole point: before, the
    // media list grew with the rows.
    expect(workbook.worksheets[0].getImages().length).toBe(21);
    expect(workbook.model.media.length).toBe(2);
  });

  it("draws only the logo when no photographs were loaded", async () => {
    // The control that gives the count above its meaning: the difference
    // between these two numbers is the photograph.
    const buffer = await buildExcel({
      ...base, columns: photoColumns, rows: photoRows, photos: null,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    expect(workbook.worksheets[0].getImages().length).toBe(1);
  });

  it("makes the row tall enough to see the photograph", async () => {
    const buffer = await buildExcel({
      ...base, columns: photoColumns, rows: photoRows, photos: loaded(),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0];

    expect(sheet.getRow(5).height).toBe(84);
    expect(sheet.getRow(6).height).toBe(30);
  });

  it("says in the subtitle when photographs were left out", async () => {
    const buffer = await buildExcel({
      ...base, columns: photoColumns, rows: photoRows,
      photos: loaded({ requested: 5000, loaded: 3000, skipped: 2000 }),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    expect(String(workbook.worksheets[0].getCell(2, 1).value)).toContain("SIN 2000 FOTOGRAFÍA");
  });

  it("writes the fallback when photographs were not requested at all", async () => {
    const buffer = await buildExcel({ ...base, columns: photoColumns, rows: photoRows });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0];

    expect(sheet.getCell(5, 2).value).toBe("Sí");
    expect(sheet.getRow(5).height).toBe(30);
  });
});
