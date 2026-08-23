import { describe, it, expect } from "vitest";
import {
  rowStyleKeys, rowTint, tintHex, tintRgb, legendFor,
  RESOLVED_HEX, BAND_HEX, CRITICALITY_HEX,
} from "./rowStyle.js";
import type { ResultColumn } from "../types.js";

const column = (over: Partial<ResultColumn> & { key: string }): ResultColumn => ({
  label: over.key,
  kind: "string",
  path: over.key,
  ...over,
});

const state = column({ key: "estado", kind: "boolean", semantic: "state" });
const criticality = column({ key: "crit", kind: "number", semantic: "criticality" });
const plain = column({ key: "desc" });

describe("rowStyleKeys", () => {
  it("resolves both keys once for the whole report", () => {
    expect(rowStyleKeys([plain, state, criticality]))
      .toEqual({ stateKey: "estado", criticalityKey: "crit" });
  });

  it("leaves a key undefined when the report has no such column", () => {
    expect(rowStyleKeys([plain])).toEqual({ stateKey: undefined, criticalityKey: undefined });
  });
});

describe("rowTint", () => {
  const both = rowStyleKeys([state, criticality]);

  it("puts resolved above severity", () => {
    // A solved catastrophic event is green. The colour answers "does this still
    // need someone?", not "how bad was it?".
    expect(rowTint({ estado: true, crit: 1 }, 0, both)).toEqual({ kind: "resolved" });
  });

  it("falls to severity when the row is not resolved", () => {
    expect(rowTint({ estado: false, crit: 1 }, 0, both)).toEqual({ kind: "criticality", level: 1 });
  });

  it("uses severity when the report has no state column", () => {
    const keys = rowStyleKeys([criticality]);

    expect(rowTint({ crit: 7 }, 0, keys)).toEqual({ kind: "criticality", level: 7 });
  });

  it("bands the rows when nothing else applies", () => {
    const keys = rowStyleKeys([plain]);

    expect(rowTint({ desc: "a" }, 0, keys)).toEqual({ kind: "band", odd: false });
    expect(rowTint({ desc: "b" }, 1, keys)).toEqual({ kind: "band", odd: true });
  });

  it("bands a row whose severity is outside the scale", () => {
    const keys = rowStyleKeys([criticality]);

    for (const crit of [null, 0, 10, "alta", 2.5]) {
      expect(rowTint({ crit }, 0, keys).kind).toBe("band");
    }
  });

  it("treats an unresolved-looking state as not resolved", () => {
    for (const estado of [null, undefined, "f", 0, false]) {
      expect(rowTint({ estado }, 0, rowStyleKeys([state])).kind).toBe("band");
    }
  });
});

describe("tintHex and tintRgb", () => {
  it("gives resolved its own green", () => {
    expect(tintHex({ kind: "resolved" })).toBe(RESOLVED_HEX);
  });

  it("maps every level of the scale", () => {
    for (let level = 1; level <= 9; level++) {
      expect(tintHex({ kind: "criticality", level })).toBe(CRITICALITY_HEX[level]);
    }
  });

  it("leaves the even band without a fill so the sheet keeps its own", () => {
    expect(tintHex({ kind: "band", odd: false })).toBeNull();
    expect(tintHex({ kind: "band", odd: true })).toBe(BAND_HEX);
  });

  it("converts to the components jsPDF expects", () => {
    expect(tintRgb({ kind: "resolved" })).toEqual([0xd4, 0xed, 0xda]);
    expect(tintRgb({ kind: "band", odd: false })).toBeNull();
  });
});

describe("legendFor", () => {
  it("shows nothing when no colour rule is in play", () => {
    expect(legendFor(rowStyleKeys([plain]))).toEqual([]);
  });

  it("shows only what the report actually uses", () => {
    expect(legendFor(rowStyleKeys([state])).map((e) => e.label)).toEqual(["Resuelto"]);
    expect(legendFor(rowStyleKeys([criticality])).map((e) => e.label))
      // The ranges are part of the label: the indicator strip beside this
      // legend counts levels 1 to 3 as críticos while only level 1 carries the
      // darkest tint, so an unqualified "Crítico" had one definition colouring
      // and another counting, in the same header band.
      .toEqual(["Crítico (1-3)", "Medio (4-6)", "Leve (7-9)"]);
  });
});
