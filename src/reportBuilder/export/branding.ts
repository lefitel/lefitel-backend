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
  /** Osefi, on the left of the band. */
  osefi: Buffer | null;
  /** Tigo, on the right. Fixed: pole owners are utilities, not operators. */
  tigo: Buffer | null;
}

let cached: Promise<Branding> | null = null;

/**
 * A missing logo is not a reason to fail an export. The band simply comes out
 * without it, and the report is still correct.
 */
export function loadBranding(): Promise<Branding> {
  cached ??= Promise.all([
    compressLogo(path.join(ASSETS, "logo.png"), LOGO_WIDTH_PX),
    compressLogo(path.join(ASSETS, "logo_tigo.png"), LOGO_WIDTH_PX),
  ]).then(([osefi, tigo]) => {
    if (osefi === null) log("export").warn({ ruta: ASSETS }, `no se encontró el logo en ${ASSETS}`);
    return { osefi, tigo };
  });
  return cached;
}

/** Only for tests, which need a cold start. */
export function resetBrandingCache(): void {
  cached = null;
}
