// The size of a one-page export is judged by the page the query will read.
//
// The guard worked the page size out for itself, and with no `limit` it assumed
// twenty thousand rows where `buildQuery` reads five hundred. So a page of a
// large report was refused as "19.000 filas × 6 columnas" over a file that
// would have held five hundred. The screen always sends a limit; a direct call
// need not.
//
// No database here on purpose: the fixture has 1.376 events and the defect
// needs a report of more than sixteen thousand, so the count is handed in.

import { describe, expect, it, vi } from "vitest";
import type { ReportConfig } from "../types.js";
import type { Viewer } from "../viewer.js";

/** What the report behind the page is said to hold. */
let total = 0;
const REACHED = "the guard let it through";

vi.mock("../execute.js", () => ({
  runReport: async (
    _config: ReportConfig, _viewer: Viewer, options: { guard: (total: number) => void },
  ) => {
    options.guard(total);
    // Past the guard is all this file asks about; building a file is the
    // integration test's business.
    throw new Error(REACHED);
  },
}));

const { buildExport, ExportTooLargeError } = await import("./index.js");

const ADMIN: Viewer = { role: 1, staff: true };
const columns = [
  { path: "poste.name" }, { path: "poste.propietario.name" }, { path: "description" },
  { path: "criticidad" }, { path: "state" }, { path: "date" },
];

const exportPdf = (config: ReportConfig, scope?: "page") =>
  buildExport({ config, viewer: ADMIN, format: "pdf", title: "Prueba", scope });

describe("the size guard of a one-page export", () => {
  it("judges a page with no limit by the five hundred rows the query reads", async () => {
    total = 19_000;
    await expect(exportPdf({ root: "evento", columns }, "page")).rejects.toThrow(REACHED);
  });

  it("still refuses the whole of that report", async () => {
    // The control: the same report, entire, is 114.000 cells against a cap of
    // 80.000. Without it the test above would pass with the guard removed.
    total = 19_000;
    await expect(exportPdf({ root: "evento", columns })).rejects.toThrow(ExportTooLargeError);
  });

  it("counts the last page as shorter than the rest", async () => {
    total = 19_000;
    await expect(
      exportPdf({ root: "evento", columns, limit: 50_000, offset: 18_900 }, "page"),
    ).rejects.toThrow(REACHED);
  });

  it("refuses a page that really is too large", async () => {
    total = 19_000;
    await expect(
      exportPdf({ root: "evento", columns, limit: 19_000, offset: 0 }, "page"),
    ).rejects.toThrow(ExportTooLargeError);
  });
});
