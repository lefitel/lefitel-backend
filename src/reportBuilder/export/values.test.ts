import { describe, it, expect } from "vitest";
import { isTrue, formatValue, toZonedExcelDate, toWinAnsi, reportFileName } from "./values.js";

describe("isTrue", () => {
  it("accepts every shape a driver hands a boolean back in", () => {
    for (const value of [true, 1, "t", "T", "true", "TRUE", " 1 "]) {
      expect(isTrue(value)).toBe(true);
    }
  });

  it("rejects everything else, including nothing at all", () => {
    for (const value of [false, 0, "f", "false", "", null, undefined, "sí", 2, {}]) {
      expect(isTrue(value)).toBe(false);
    }
  });
});

describe("formatValue", () => {
  it("marks an absent value instead of printing an empty cell", () => {
    for (const empty of [null, undefined, ""]) {
      expect(formatValue(empty, "string")).toBe("—");
    }
  });

  it("writes booleans the way the screen does", () => {
    expect(formatValue(true, "boolean")).toBe("Sí");
    expect(formatValue("f", "boolean")).toBe("No");
  });

  it("reads dates in the report's zone, not the server's", () => {
    // 02:00 UTC is still the previous day in La Paz. A server in Europe must
    // not shift every date in the report by one.
    expect(formatValue("2026-03-15T02:00:00.000Z", "date")).toBe("14/03/2026");
  });

  it("leaves an unparseable date as the text it was", () => {
    expect(formatValue("no es fecha", "date")).toBe("no es fecha");
  });

  it("keeps whole numbers exact and groups the rest", () => {
    // An id must stay readable as an id: 1376, never 1.376.
    expect(formatValue(1376, "number")).toBe("1376");
    expect(formatValue(1376.5, "number")).toBe("1.376,5");
  });

  it("keeps a non-finite number as its original text", () => {
    expect(formatValue("1e400", "number")).toBe("1e400");
  });

  it("never prints a stored image path", () => {
    // Photographs are served from an unauthenticated root: a path is a public
    // URL, and a column of them is a list of field photographs.
    expect(formatValue("/1778185422691_foto.webp", "image")).toBe("Sí");
  });
});

describe("toZonedExcelDate", () => {
  it("shifts an instant so the sheet shows the report's zone", () => {
    const shifted = toZonedExcelDate(new Date("2026-03-15T02:00:00.000Z"));

    expect(shifted?.getUTCDate()).toBe(14);
    expect(shifted?.getUTCMonth()).toBe(2);
  });

  it("returns null outside the range a spreadsheet can hold", () => {
    // Intl silently reported 1901 for year 1, so the range is checked on the
    // instant itself and not on what came back from the conversion.
    expect(toZonedExcelDate(new Date("0001-01-01T00:00:00Z"))).toBeNull();
    expect(toZonedExcelDate(new Date(8.64e15))).toBeNull();
  });
});

describe("toWinAnsi", () => {
  it("keeps Spanish untouched", () => {
    expect(toWinAnsi("Descripción «áéíóú» ñÑ °")).toBe("Descripción «áéíóú» ñÑ °");
  });

  it("transliterates the symbols the reports use", () => {
    expect(toWinAnsi("✓ pendiente → resuelto")).toBe("Si pendiente -> resuelto");
    expect(toWinAnsi("—")).toBe("-");
  });

  it("replaces what the font cannot encode instead of corrupting the line", () => {
    // One emoji used to turn a whole string into raw UTF-16 bytes.
    expect(toWinAnsi("poste 😀 caído")).toBe("poste ? caído");
    expect(toWinAnsi("中文")).toBe("??");
  });
});

describe("reportFileName", () => {
  it("stamps the name down to the second", () => {
    expect(reportFileName("Mensual", "xlsx"))
      .toMatch(/^Mensual_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.xlsx$/);
  });

  it("removes the characters a filesystem refuses", () => {
    expect(reportFileName("Con/barras:y*asteriscos", "pdf"))
      .toMatch(/^Con barras y asteriscos_/);
    expect(reportFileName("con\\contrabarra", "pdf")).toMatch(/^con contrabarra_/);
  });

  it("falls back when nothing usable is left", () => {
    // Replacing first and checking after turned a title of slashes into "---".
    expect(reportFileName("///", "pdf")).toMatch(/^Reporte_/);
    expect(reportFileName("   ", "pdf")).toMatch(/^Reporte_/);
  });

  it("trims a title long enough to break a filesystem", () => {
    const name = reportFileName("x".repeat(200), "xlsx");

    expect(name.startsWith("x".repeat(60) + "_")).toBe(true);
  });
});
