// Where an uploaded photograph is allowed to land.
//
// The name arrives from the browser and went into the destination by string
// concatenation, so it decided the path: `../../../tmp/pwn.png` wrote outside
// the images directory, and every account with a session could do it — the
// route carries authentication and nothing else, and is one of the two entries
// `routeGuards.test.ts` lists as deliberately ungated.
//
// Reading was hardened long before this: `%2F` inside a route parameter had let
// an administrator delete any file the process could reach. The writer was left
// alone. This is the test that keeps them at the same standard.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { safeName } from "./upload.controller.js";
import { resolveImagePath } from "../utils/fileUtils.js";

const IMAGES = "C:/images";

/** Where a name would actually be written, or null if it is refused. */
const destinationFor = (uploaded: unknown) => resolveImagePath(safeName(uploaded), IMAGES);

describe("the name a photograph is stored under", () => {
  it("keeps every hostile shape inside the images directory", () => {
    const hostile = [
      "../../../tmp/pwn.png",
      "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "images/../../secreto.png",
      "foto/../../../otra.png",
      "\u0000nulo.png",
      "....//....//escape.png",
      ".",
      "..",
    ];

    const root = path.resolve(IMAGES);
    for (const name of hostile) {
      const destination = destinationFor(name);
      expect(destination, name).not.toBeNull();
      expect(destination!.startsWith(root + path.sep), name).toBe(true);
      // And nothing of the original path survives into the file name.
      expect(path.basename(destination!), name).not.toContain("..");
      expect(path.basename(destination!), name).toMatch(/^\d+_[A-Za-z0-9 _-]*\.webp$/);
    }
  });

  it("keeps a readable name for an ordinary upload", () => {
    // A sanitiser that turns every photograph into `1771234567890_.webp` is
    // safe and useless: the file name is what someone reads in the folder.
    expect(safeName("poste roto en la curva.JPG")).toMatch(/^\d+_poste_roto_en_la_curva\.webp$/);
    expect(safeName("P-1024.png")).toMatch(/^\d+_P-1024\.webp$/);
  });

  it("always produces a name, whatever it was handed", () => {
    // multer can hand over an empty name, and a body without a file at all
    // reaches this code as `undefined`.
    for (const nothing of ["", "   ", "...", "%%%.png", undefined, null, 7, {}]) {
      expect(safeName(nothing), JSON.stringify(nothing)).toMatch(/^\d+_[A-Za-z0-9 _-]*\.webp$/);
      expect(destinationFor(nothing), JSON.stringify(nothing)).not.toBeNull();
    }
  });

  it("does not let an accent or an emoji become a path", () => {
    // Decomposed accents and anything outside the allowlist are dropped rather
    // than transliterated: what matters is that the result is a plain name.
    const name = safeName("Ñandú 📸 ártico.jpeg");
    expect(name).toMatch(/^\d+_[A-Za-z0-9 _-]*\.webp$/);
    expect(destinationFor("Ñandú 📸 ártico.jpeg")).not.toBeNull();
  });

  it("cannot be made long enough to break the filesystem", () => {
    expect(safeName("a".repeat(5000) + ".png").length).toBeLessThan(100);
  });
});
