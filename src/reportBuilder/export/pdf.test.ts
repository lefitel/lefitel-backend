import { describe, it, expect } from "vitest";
import { buildPdf, chunkColumns, type PdfInput } from "./pdf.js";
import type { ResultColumn } from "../types.js";

const column = (over: Partial<ResultColumn> & { key: string }): ResultColumn => ({
  label: over.key,
  kind: "string",
  ...over,
});

const base: PdfInput = {
  columns: [
    column({ key: "c0", label: "Descripción" }),
    column({ key: "c1", label: "Fecha", kind: "date" }),
    column({ key: "c2", label: "Gravedad", kind: "number", semantic: "criticality" }),
    column({ key: "c3", label: "Cerrado", kind: "boolean", semantic: "state" }),
  ],
  rows: [
    { c0: "Poste inclinado", c1: "2026-03-15T02:00:00.000Z", c2: 1, c3: false },
    { c0: "Vano bajo", c1: null, c2: 5, c3: true },
  ],
  title: "Eventos de marzo",
  subtitle: "Una fila por evento",
  noun: "eventos",
};

/** A PDF is a container, so the assertions are about it being one, and holding text. */
const asText = (buffer: Buffer) => buffer.toString("latin1");

describe("chunkColumns", () => {
  it("splits a wide report into readable parts", () => {
    const columns = Array.from({ length: 60 }, (_, i) => i);
    const chunks = chunkColumns(columns);

    expect(chunks.length).toBeGreaterThan(1);
    // No part may exceed what fits at the minimum readable width.
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(15);
    expect(chunks.flat()).toEqual(columns);
  });

  it("leaves a narrow report in one piece", () => {
    expect(chunkColumns([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("returns one empty group for no columns", () => {
    expect(chunkColumns([])).toEqual([[]]);
  });
});

describe("buildPdf", () => {
  it("produces a document a reader can open", async () => {
    const buffer = await buildPdf(base);

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1_000);
  });

  it("costs kilobytes, not megabytes, for a small report", async () => {
    // logo.png is 512×512 and jsPDF stores a PNG uncompressed: embedded as it
    // comes, a two-row report weighed a megabyte, nearly all of it logo.
    const buffer = await buildPdf(base);

    expect(buffer.length).toBeLessThan(300_000);
  });

  it("survives a report with no rows", async () => {
    const buffer = await buildPdf({ ...base, rows: [] });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("survives a report with no columns", async () => {
    const buffer = await buildPdf({ ...base, columns: [], rows: [] });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("breaks a very wide report into parts instead of shrinking it to nothing", async () => {
    const columns = Array.from({ length: 40 }, (_, i) =>
      column({ key: `c${i}`, label: `Columna número ${i}` }));
    const rows = [Object.fromEntries(columns.map((c) => [c.key, "valor"]))];

    const buffer = await buildPdf({ ...base, columns, rows });

    expect(asText(buffer)).toContain("parte 1 de 3");
  });

  it("does not label parts when everything fits on one width", async () => {
    expect(asText(await buildPdf(base))).not.toContain("parte 1 de");
  });

  it("numbers every page with the total", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ c0: `fila ${i}`, c1: null, c2: 3, c3: false }));

    const text = asText(await buildPdf({ ...base, rows }));

    expect(text).toContain("Pagina 1 de");
    expect(text).toContain("Osefi srl");
  });

  it("writes the title where the reader sees it", async () => {
    expect(asText(await buildPdf(base))).toContain("Eventos de marzo");
  });

  it("writes the indicator strip", async () => {
    const text = asText(await buildPdf(base));

    expect(text).toContain("resueltos");
    expect(text).toContain("pendientes");
    // "críticos" carries an accent the built-in font re-encodes, so only the
    // tail is literal. It used to assert on "cr", which also matches
    // "Descripcion" in the table below and so passed with the indicator gone.
    expect(text).toContain("ticos");
  });

  it("leaves the criticality indicator out when no column carries it", async () => {
    // The control for the assertion above: without this, "ticos" could come
    // from anywhere on the page and the strip would not be what is measured.
    const withoutCriticality = {
      ...base,
      columns: base.columns.filter((c) => c.semantic !== "criticality"),
    };

    expect(asText(await buildPdf(withoutCriticality))).not.toContain("ticos");
  });

  it("names the rows with the noun it is given", async () => {
    expect(asText(await buildPdf({ ...base, noun: "tramos" }))).toContain("tramos");
  });

  it("replaces what the built-in font cannot encode", async () => {
    // A single emoji used to turn a whole cell into raw UTF-16 bytes.
    const buffer = await buildPdf({
      ...base,
      rows: [{ c0: "poste 😀 caído", c1: null, c2: 1, c3: false }],
    });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(asText(buffer)).not.toContain("😀");
  });

  it("does not throw on a report whose values are all absent", async () => {
    const buffer = await buildPdf({
      ...base,
      rows: [{ c0: null, c1: null, c2: null, c3: null }],
    });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
