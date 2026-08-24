// Reads report photographs from disk and compresses them for embedding.
//
// Nothing here trusts the stored value. It is a file name that came out of the
// database, and the database is not the boundary: a name is only ever a name,
// never a path, and the resolved location is checked to be inside the images
// directory before anything is opened.

import { promises as fs } from "node:fs";
import sharp from "sharp";
import { IMAGES_DIR, resolveImagePath } from "../../utils/fileUtils.js";

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
  /**
   * How many were asked for and could not be read.
   *
   * This number had nowhere to live, so it was lost: `skipped` counted only
   * the cap, and a photograph whose file was missing or corrupt was neither
   * loaded nor skipped — it simply evaporated. The workbook then printed "Sí"
   * in every image cell, which is exactly what it prints when photographs were
   * never requested, and said nothing anywhere. Asking for 1.376 photographs
   * and receiving a 37 KB file with none of them looked like a working export.
   */
  failed: number;
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
  options: {
    directory?: string;
    cap?: number;
    concurrency?: number;
    /**
     * Aborted when the caller hangs up. Reading two thousand photographs is the
     * longest part of an export, so the workers check between files: an
     * abandoned export stops here rather than finishing a file for nobody while
     * holding the only export slot in the process.
     */
    signal?: AbortSignal;
  } = {},
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

  // Grouped by the file each value resolves to, not by the value itself. The
  // data stores two spellings of the same location — 3.090 rows as "/foto.jpg"
  // and 424 as "images/foto.jpg", an older upload path that survived — so
  // deduplicating by name made one photograph two: opened, resized and encoded
  // twice, and embedded twice in the same workbook. The cap counts files for
  // the same reason: it bounds reading and weight, and both are per file.
  // (Case is not folded, so on Windows two spellings that differ only in case
  // are still two files here. Nothing in the data does that today.)
  const byFile = new Map<string, string[]>();
  let failed = 0;
  for (const value of distinct) {
    const file = resolveImagePath(value, directory);
    // Refused before the disk: outside the images directory, or not a name.
    if (file === null) {
      failed += 1;
      continue;
    }
    const sharing = byFile.get(file);
    if (sharing) sharing.push(value);
    else byFile.set(file, [value]);
  }

  const files = [...byFile.keys()];
  const wanted = files.slice(0, cap);
  const images = new Map<string, Buffer>();

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= wanted.length) return;
      // Between files, not mid-file: a partial read is not worth saving, and
      // stopping here is enough to give the slot back in the same second.
      if (options.signal?.aborted) return;
      const file = wanted[index];
      const buffer = await compress(file);
      if (buffer === null) {
        failed += byFile.get(file)!.length;
        continue;
      }
      // Every value that named this file gets the one buffer that was read.
      for (const value of byFile.get(file)!) images.set(value, buffer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));

  // loaded + skipped + failed = requested, always. Whatever is left over —
  // files beyond the cap, and files the workers never reached because the
  // caller hung up — is counted as skipped, so the sentence printed in the file
  // still accounts for every photograph the report asked for.
  return {
    images,
    requested: distinct.length,
    loaded: images.size,
    skipped: Math.max(0, distinct.length - images.size - failed),
    failed,
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
