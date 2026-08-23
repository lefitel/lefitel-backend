// The words the user reads, where they cross from one file into another.
//
// Two audits found the same shape of defect over and over: a name that exists
// twice, once for the control and once for the sentence explaining it. Nothing
// in the suite watched for it, because every existing test asserts on SQL or on
// behaviour, and a label is neither. So it survived: the dropdown said «está
// entre» while the error about it said "entre"; a column header read
// «Fecha de revisión (max)» beside a control offering «Máximo»; a message asked
// for a field the screen has no way to name.
//
// These are the crossings. If a second vocabulary appears, one of these fails.

import { describe, it, expect } from "vitest";
import { AGG_LABEL, OPERATOR_LABEL, KIND_LABEL } from "./constraints.js";
import { buildQuery } from "./sqlBuilder.js";
import { ReportConfigError } from "./types.js";
import type { ReportConfig } from "./types.js";
import type { Viewer } from "./viewer.js";

const ADMIN: Viewer = { role: 1, staff: true };

/** Runs a configuration and returns the message, or null if it was accepted. */
function refusal(config: unknown): string | null {
  try {
    buildQuery(config as ReportConfig, ADMIN);
    return null;
  } catch (error) {
    if (error instanceof ReportConfigError) return error.message;
    throw error;
  }
}

describe("the operator names the user reads", () => {
  // The client's dropdown is the canonical set — it is the one people see and
  // point at. Hardcoded here rather than imported because the point is that the
  // two files agree, and importing across the repo boundary would make the test
  // pass by construction.
  const SHOWN_IN_THE_PICKER = {
    eq: "es igual a",
    neq: "es distinto de",
    gt: "es mayor que",
    gte: "es mayor o igual que",
    lt: "es menor que",
    lte: "es menor o igual que",
    between: "está entre",
    in: "está en la lista",
    like: "contiene",
    isnull: "está vacío",
    notnull: "tiene valor",
  };

  it("are the same words the picker offers", () => {
    // Eight of eleven diverged. An error quoting an operator the user cannot
    // find in the dropdown is an error they cannot act on.
    expect(OPERATOR_LABEL).toEqual(SHOWN_IN_THE_PICKER);
  });

  it("reach the message instead of being typed into it", () => {
    // Two messages held a third copy of the vocabulary as a literal.
    const between = refusal({
      root: "evento",
      columns: [{ path: "id" }],
      filters: { op: "and", conditions: [{ path: "date", operator: "between", value: ["2026-01-01"] }] },
    });
    expect(between).toContain(OPERATOR_LABEL.between);

    const inList = refusal({
      root: "evento",
      columns: [{ path: "id" }],
      filters: { op: "and", conditions: [{ path: "description", operator: "in", value: [] }] },
    });
    expect(inList).toContain(OPERATOR_LABEL.in);
  });
});

describe("the summary names the user reads", () => {
  it("never leak the English key into a column header", () => {
    // `label: ${field.label} (${agg})` shipped «Fecha de revisión (max)» into
    // the result, the Excel and the PDF, beside a control saying «Máximo».
    const built = buildQuery(
      {
        root: "evento",
        columns: [{ path: "id" }, { path: "revisiones.date", agg: "max" }],
      } as unknown as ReportConfig,
      ADMIN,
    );
    const header = built.columns.map((c) => c.label).join(" | ");
    expect(header).toContain(AGG_LABEL.max);
    for (const key of Object.keys(AGG_LABEL)) {
      expect(header).not.toContain(`(${key})`);
    }
  });

  it("never leak the English key into a message", () => {
    const said = refusal({
      root: "evento",
      columns: [{ path: "id" }, { path: "revisiones", agg: "sum" }],
    });
    expect(said).not.toBeNull();
    expect(said).toContain(AGG_LABEL.sum);
    expect(said).not.toMatch(/"sum"|«sum»/);
  });

  it("are the words the column list offers, in lower case for mid-sentence use", () => {
    // The control shows «Conteo», «Suma», …; a sentence needs «el conteo».
    // Same words, different casing, and that is the only difference allowed.
    const SHOWN_IN_THE_LIST = ["Conteo", "Suma", "Promedio", "Mínimo", "Máximo"];
    expect(Object.values(AGG_LABEL)).toEqual(SHOWN_IN_THE_LIST.map((w) => w.toLowerCase()));
  });
});

describe("field types are named in Spanish", () => {
  it("has a word for every kind, and no English among them", () => {
    expect(Object.values(KIND_LABEL)).toEqual(["texto", "número", "fecha", "sí/no", "imagen"]);
  });

  it("uses it rather than the key when refusing a summary", () => {
    const said = refusal({
      root: "evento",
      columns: [{ path: "description", agg: "sum" }],
    });
    expect(said).toContain(KIND_LABEL.string);
    expect(said).not.toContain("string");
  });
});

describe("no message quotes an internal identifier where a label exists", () => {
  it("names the field, not the dotted path, when the field is real", () => {
    // A path is the right thing to print when nothing else identifies the
    // field — a path that does not exist. When the field *does* exist, the
    // label is what the user can find on screen.
    const said = refusal({
      root: "evento",
      columns: [{ path: "poste.name", agg: "sum" }],
    });
    expect(said).not.toBeNull();
    expect(said).not.toContain("poste.name");
  });
});
