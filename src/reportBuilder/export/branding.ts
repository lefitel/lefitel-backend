// The logos that head every exported report.
//
// Loaded and compressed once for the life of the process, not once per report:
// the source is 512×512 and jsPDF stores a PNG uncompressed, so embedding it as
// it comes adds about a megabyte to every document.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressLogo } from "./photos.js";
import { log } from "../../utils/logger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/reportBuilder/export → src/assets, and dist/reportBuilder/export →
// dist/assets once copy-assets has run.
const ASSETS = path.resolve(here, "../../assets/images");

/**
 * Drawn 18 mm wide, which makes 160 px about 226 dpi — beyond what an office
 * printer resolves. Measured inside a PDF, where jsPDF re-encodes a PNG to raw
 * pixels and the pixel count is what costs: 96 px adds 20 KB to a document,
 * 160 px adds 52 KB, 240 px adds 114 KB and the untouched 512 px original adds
 * 514 KB. jsPDF reuses the object across pages, so it is paid once.
 */
const LOGO_WIDTH_PX = 160;

export interface Branding {
  /** Osefi, on the left of the band. The only one. */
  osefi: Buffer | null;
}

/*
 * There used to be a second logo, an operator's, drawn on the right of every
 * band. It was hard-coded: nothing at run time chose it — not the report, not
 * the filters, not the data — and it was there because the generator was built
 * to match the hand-written report that already carried it.
 *
 * Three things were wrong with that. The other hand-written report, in the same
 * directory, carries only this one, so two documents from one system already
 * went out branded differently. The database holds twelve pole owners. And a
 * report can be filtered down to one of them, which handed somebody a document
 * about another company's poles under a third company's mark.
 *
 * Removed by Isaias's decision on 2026-09-08. The image is in the history if a
 * per-report choice is ever wanted.
 */

let cached: Promise<Branding> | null = null;

/**
 * A missing logo is not a reason to fail an export. The band simply comes out
 * without it, and the report is still correct.
 */
export function loadBranding(): Promise<Branding> {
  cached ??= compressLogo(path.join(ASSETS, "logo.png"), LOGO_WIDTH_PX).then((osefi) => {
    if (osefi === null) log("export").warn({ ruta: ASSETS }, `no se encontró el logo en ${ASSETS}`);
    return { osefi };
  });
  return cached;
}

/** Only for tests, which need a cold start. */
export function resetBrandingCache(): void {
  cached = null;
}
