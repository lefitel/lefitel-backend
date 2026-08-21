import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPhotos, compressLogo, PHOTO_MAX_PX } from "./photos.js";

const require = createRequire(import.meta.url);
const sharp = require("sharp") as typeof import("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));

let directory: string;

/** A real image on disk, since the point is exercising sharp, not a stub. */
async function writeImage(name: string, width: number, height: number, format: "webp" | "jpeg") {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 40, b: 40 } },
  })[format]().toBuffer();
  await fs.writeFile(path.join(directory, name), buffer);
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "osefi-photos-"));
  // Uploads are stored as webp, which ExcelJS cannot embed: sharp converting
  // them is one of the reasons this moved to the server.
  await writeImage("uno.webp", 800, 600, "webp");
  await writeImage("dos.webp", 400, 400, "webp");
  await writeImage("tres.jpg", 1200, 300, "jpeg");
  await fs.writeFile(path.join(directory, "no-es-imagen.webp"), "esto es texto plano");
});

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("loadPhotos", () => {
  it("loads every photograph a report asks for", async () => {
    const result = await loadPhotos(["/uno.webp", "/dos.webp", "/tres.jpg"], { directory });

    expect(result.requested).toBe(3);
    expect(result.loaded).toBe(3);
    expect(result.skipped).toBe(0);
    expect([...result.images.keys()].sort()).toEqual(["/dos.webp", "/tres.jpg", "/uno.webp"]);
  });

  it("keys the result by the stored value, not by the file name", async () => {
    // The caller has a row, and the row holds "/uno.webp". Anything else would
    // make it look the image up by guessing.
    const result = await loadPhotos(["/uno.webp"], { directory });

    expect(result.images.has("/uno.webp")).toBe(true);
    expect(result.images.has("uno.webp")).toBe(false);
  });

  it("produces a JPEG no larger than the embedding size", async () => {
    const result = await loadPhotos(["/uno.webp"], { directory });
    const buffer = result.images.get("/uno.webp")!;
    const meta = await sharp(buffer).metadata();

    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(PHOTO_MAX_PX);
    // An 800×600 source has to come down by an order of magnitude to be worth
    // embedding two thousand times.
    expect(buffer.length).toBeLessThan(20_000);
  });

  it("keeps the aspect ratio instead of squashing the photograph", async () => {
    const result = await loadPhotos(["/tres.jpg"], { directory });
    const meta = await sharp(result.images.get("/tres.jpg")!).metadata();

    expect(meta.width).toBe(PHOTO_MAX_PX);
    expect(meta.height).toBe(PHOTO_MAX_PX / 4);
  });

  it("asks for each distinct photograph once", async () => {
    const result = await loadPhotos(["/uno.webp", "/uno.webp", "/uno.webp"], { directory });

    expect(result.requested).toBe(1);
    expect(result.loaded).toBe(1);
  });

  it("skips a name that tries to leave the directory, and keeps going", async () => {
    const result = await loadPhotos(["../../package.json", "/uno.webp"], { directory });

    expect(result.loaded).toBe(1);
    expect(result.images.has("/uno.webp")).toBe(true);
  });

  it("survives a file that is missing or is not an image", async () => {
    // One bad photograph must not cost the user the whole export.
    const result = await loadPhotos(
      ["/no-existe.webp", "/no-es-imagen.webp", "/dos.webp"],
      { directory },
    );

    expect(result.requested).toBe(3);
    expect(result.loaded).toBe(1);
    expect(result.images.has("/dos.webp")).toBe(true);
  });

  it("stops at the cap and says how many it left out", async () => {
    const result = await loadPhotos(["/uno.webp", "/dos.webp", "/tres.jpg"], { directory, cap: 2 });

    expect(result.requested).toBe(3);
    expect(result.loaded).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("accounts for every photograph it was asked for", async () => {
    // The identity that makes the count trustworthy: loaded + over the cap +
    // unreadable is everything asked for. Before, a file that could not be read
    // was neither loaded nor skipped — it evaporated, and the workbook printed
    // "Si" in its cell exactly as it does when photographs were never
    // requested. 1.376 asked for, none delivered, and nothing anywhere saying
    // so.
    const asked = [
      "/uno.webp",            // reads
      "/dos.webp",            // reads
      "/no-existe.webp",      // missing
      "/no-es-imagen.webp",   // present, not an image
      "../fuera.webp",        // refused before it reaches the disk
    ];
    const result = await loadPhotos(asked, { directory });

    expect(result.requested).toBe(5);
    expect(result.loaded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.loaded + result.skipped + result.failed).toBe(result.requested);
  });

  it("counts the ones over the cap apart from the ones it could not read", async () => {
    // Two different problems that need two different sentences in the file: the
    // report being too big for one spreadsheet, and the photograph not being on
    // this server.
    const result = await loadPhotos(
      ["/uno.webp", "/dos.webp", "/no-existe.webp"],
      { directory, cap: 2 },
    );

    expect(result.requested).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.loaded + result.skipped + result.failed).toBe(result.requested);
  });

  it("returns nothing for a report with no photographs", async () => {
    const result = await loadPhotos([null, undefined, "", "   ", 42], { directory });

    expect(result).toMatchObject({ requested: 0, loaded: 0, skipped: 0 });
    expect(result.images.size).toBe(0);
  });

  it("loads the same set whatever the concurrency", async () => {
    const names = ["/uno.webp", "/dos.webp", "/tres.jpg"];

    const serial = await loadPhotos(names, { directory, concurrency: 1 });
    const parallel = await loadPhotos(names, { directory, concurrency: 8 });

    expect([...serial.images.keys()].sort()).toEqual([...parallel.images.keys()].sort());
  });
});

describe("compressLogo", () => {
  it("brings a logo down to the size it is drawn at", async () => {
    // logo.png is 512×512 and 196 KB, and jsPDF stores it uncompressed: every
    // report the system has produced carries about a megabyte of logo.
    //
    // Resolved from this file rather than the working directory, and from this
    // repository's own copy of the asset: reaching into the sibling checkout
    // made the assertion vanish silently whenever it was absent or renamed.
    const source = path.resolve(here, "../../assets/images/logo.png");
    const buffer = await compressLogo(source, 200);
    if (buffer === null) throw new Error(`no está el logo en ${source}`);

    expect(buffer.length).toBeLessThan(30_000);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(200);
    expect(meta.format).toBe("png");
  });

  it("returns null instead of throwing when the file is not there", async () => {
    expect(await compressLogo(path.join(directory, "no-existe.png"), 200)).toBeNull();
  });
});
