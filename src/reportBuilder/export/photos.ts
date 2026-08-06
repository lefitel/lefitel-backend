// Reads report photographs from disk and compresses them for embedding.
//
// Nothing here trusts the stored value. It is a file name that came out of the
// database, and the database is not the boundary: a name is only ever a name,
// never a path, and the resolved location is checked to be inside the images
// directory before anything is opened.

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { IMAGES_DIR, resolveImagePath } from "../../utils/fileUtils.js";

// sharp ships as CommonJS with a native binding; the default ESM interop hands
// back the namespace rather than the callable.
const require = createRequire(import.meta.url);
const sharp = require("sharp") as typeof import("sharp");

// libvips keeps up to a hundred of the files it has opened cached by descriptor.
// A long-running server that reads thousands of distinct photographs holds those
// descriptors for as long as it lives, and on Windows the files cannot even be
// deleted. The operation and memory caches are worth keeping; the file one is
// not, since a report reads each photograph once.
sharp.cache({ files: 0 });

/** Longest side in pixels, and JPEG quality. The numbers reportGeneral uses. */
export const PHOTO_MAX_PX = 160;
export const PHOTO_QUALITY = 65;

/** Above this the spreadsheet stops being something Excel opens comfortably. */
export const MAX_EXPORT_PHOTOS = 3_000;

/** Disk and sharp's thread pool both suffer if this goes much higher. */
export const PHOTO_READ_CONCURRENCY = 8;

export interface LoadedPhotos {
  /** Stored value as it appears in the row, mapped to a JPEG buffer. */
  images: Map<string, Buffer>;
  /** Distinct names the report asked for. */
  requested: number;
  /** How many produced an image. */
  loaded: number;
  /** How many were left out because the cap was reached. */
  skipped: number;
}

async function compress(file: string): Promise<Buffer | null> {
  try {
    return await sharp(file, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: PHOTO_MAX_PX, height: PHOTO_MAX_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: PHOTO_QUALITY })
      .toBuffer();
  } catch {
    // A missing file, a corrupt upload or something that is not an image at all.
    // One bad photograph must not cost the user the whole export.
    return null;
  }
}

/**
 * Loads every distinct photograph a report needs, a few at a time.
 *
 * Sequential reads are what made the browser take minutes; unbounded ones would
 * simply move the problem onto the disk. Order does not matter, so the work is
 * handed out to a fixed number of workers pulling from one list.
 */
export async function loadPhotos(
  values: readonly unknown[],
  options: { directory?: string; cap?: number; concurrency?: number } = {},
): Promise<LoadedPhotos> {
  const directory = options.directory ?? IMAGES_DIR;
  const cap = options.cap ?? MAX_EXPORT_PHOTOS;
  const concurrency = Math.max(1, options.concurrency ?? PHOTO_READ_CONCURRENCY);

  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    distinct.push(value);
  }

  const wanted = distinct.slice(0, cap);
  const images = new Map<string, Buffer>();

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= wanted.length) return;
      const value = wanted[index];
      const file = resolveImagePath(value, directory);
      if (file === null) continue;
      const buffer = await compress(file);
      if (buffer !== null) images.set(value, buffer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));

  return {
    images,
    requested: distinct.length,
    loaded: images.size,
    skipped: distinct.length - wanted.length,
  };
}

/** Bytes of a branding image, resized and left as PNG so transparency survives. */
export async function compressLogo(file: string, widthPx: number): Promise<Buffer | null> {
  try {
    await fs.access(file);
    return await sharp(file)
      .resize({ width: widthPx, withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
  } catch {
    return null;
  }
}
