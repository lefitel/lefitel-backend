import { describe, it, expect } from "vitest";
import { buildIndicators, formatIndicators, CRITICAL_MAX_LEVEL } from "./indicators.js";
import type { ResultColumn } from "../types.js";

const column = (over: Partial<ResultColumn> & { key: string }): ResultColumn => ({
  label: over.key,
  kind: "string",
  // A result column now says which field it came from, so the table can sort by
  // its own headers. These fixtures do not care which, only that it is there.
  path: over.key,
  ...over,
});

const state = column({ key: "estado", kind: "boolean", semantic: "state" });
const criticality = column({ key: "crit", kind: "number", semantic: "criticality" });
const plain = column({ key: "desc" });

describe("buildIndicators", () => {
  it("shows only the total when no column carries meaning", () => {
    const indicators = buildIndicators([plain], [{ desc: "a" }, { desc: "b" }], "eventos");

    expect(indicators).toEqual([{ label: "eventos", value: 2, tone: "neutral" }]);
  });

  it("names the total with the noun it is given, not with a fixed word", () => {
    // Grouping by tramo makes a row a tramo. Saying "eventos" over a list of
    // tramos is the kind of quiet lie a report must never tell.
    const [total] = buildIndicators([plain], [{ desc: "a" }], "tramos");

    expect(total).toEqual({ label: "tramos", value: 1, tone: "neutral" });
  });

  it("splits resolved from pending when a state column is present", () => {
    const rows = [{ estado: true }, { estado: false }, { estado: true }];

    const indicators = buildIndicators([state], rows, "eventos");

    expect(indicators).toEqual([
      { label: "eventos", value: 3, tone: "neutral" },
      { label: "resueltos", one: "resuelto", value: 2, tone: "good" },
      { label: "pendientes", one: "pendiente", value: 1, tone: "warn" },
    ]);
  });

  it("counts an unknown state as pending so the parts add up to the whole", () => {
    const rows = [{ estado: true }, { estado: null }, { estado: undefined }];

    const [total, resolved, pending] = buildIndicators([state], rows, "eventos");

    expect(resolved.value + pending.value).toBe(total.value);
    expect(resolved.value).toBe(1);
  });

  it("reads the booleans a driver may hand back as text or as a number", () => {
    const rows = [{ estado: "t" }, { estado: "true" }, { estado: 1 }, { estado: "f" }, { estado: 0 }];

    const [, resolved] = buildIndicators([state], rows, "eventos");

    expect(resolved.value).toBe(3);
  });

  it("counts levels 1 to 3 as critical and nothing else", () => {
    const rows = [1, 2, 3, 4, 9].map((crit) => ({ crit }));

    const indicators = buildIndicators([criticality], rows, "eventos");

    expect(CRITICAL_MAX_LEVEL).toBe(3);
    expect(indicators.at(-1)).toEqual({ label: "críticos", one: "crítico", value: 3, tone: "bad" });
  });

  it("ignores criticality values that are not a level", () => {
    const rows = [{ crit: null }, { crit: "alta" }, { crit: 0 }, { crit: 1.5 }, { crit: 12 }];

    const indicators = buildIndicators([criticality], rows, "eventos");

    expect(indicators.at(-1)?.value).toBe(0);
  });

  it("combines both when the report carries both", () => {
    const rows = [
      { estado: true, crit: 1 },
      { estado: false, crit: 2 },
      { estado: false, crit: 7 },
    ];

    const indicators = buildIndicators([state, criticality], rows, "eventos");

    expect(indicators.map((i) => [i.label, i.value])).toEqual([
      ["eventos", 3], ["resueltos", 1], ["pendientes", 2], ["críticos", 2],
    ]);
  });

  it("ignores a column that merely looks like one of them", () => {
    // The user renames labels freely; only the declared meaning counts.
    const lookalike = column({ key: "c", label: "Criticidad promedio", kind: "number" });

    const indicators = buildIndicators([lookalike], [{ c: 1 }], "eventos");

    expect(indicators).toHaveLength(1);
  });

  it("survives a report with no rows", () => {
    const indicators = buildIndicators([state, criticality], [], "eventos");

    expect(indicators.map((i) => i.value)).toEqual([0, 0, 0, 0]);
  });

  it("uses the first column of each meaning when there are several", () => {
    const second = column({ key: "estado2", kind: "boolean", semantic: "state" });

    const indicators = buildIndicators([state, second], [{ estado: true, estado2: false }], "eventos");

    expect(indicators.find((i) => i.label === "resueltos")?.value).toBe(1);
  });
});

describe("formatIndicators", () => {
  it("writes the strip the way it is read", () => {
    const text = formatIndicators([
      { label: "eventos", value: 1376, tone: "neutral" },
      { label: "resueltos", value: 597, tone: "good" },
    ]);

    expect(text).toBe("1.376 eventos  ·  597 resueltos");
  });

  it("returns an empty string for an empty strip", () => {
    expect(formatIndicators([])).toBe("");
  });
});

describe("one of something is not «1 eventos»", () => {
  // The "1 filas" shape, in every exported file: the labels are fixed plurals
  // and the value is prefixed verbatim, so a one-row report printed
  // "1 eventos · 1 resueltos · 0 pendientes · 1 críticos" in the PDF band and
  // the Excel strip. The screen gets this right two panels away.
  it("uses the singular for a count of one, and the plural for zero", () => {
    const text = formatIndicators([
      { label: "eventos", one: "evento", value: 1, tone: "neutral" },
      { label: "resueltos", one: "resuelto", value: 1, tone: "good" },
      { label: "pendientes", one: "pendiente", value: 0, tone: "warn" },
      { label: "críticos", one: "crítico", value: 1, tone: "bad" },
    ]);
    expect(text).toBe("1 evento  ·  1 resuelto  ·  0 pendientes  ·  1 crítico");
  });

  it("keeps the plural when there is no singular to use", () => {
    // The row noun for an unknown root falls back to the entity label, which
    // has no plural form to pair with — better a wrong "-s" than a guess that
    // mangles the word.
    const text = formatIndicators([{ label: "grupos", value: 1, tone: "neutral" }]);
    expect(text).toBe("1 grupos");
  });
});
