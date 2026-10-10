import { describe, it, expect } from "vitest";
import path from "node:path";
import { imageFileName, resolveImagePath } from "./fileUtils.js";

const ROOT = path.resolve("/tmp/osefi-images");

describe("imageFileName", () => {
  // The one place the two stored shapes meet. Everything that compares a
  // stored value with a file on disk has to agree on this answer, and the
  // Archivos screen did not — see `files.controller.test.ts`.
  it("maps both stored shapes to the same bare name", () => {
    expect(imageFileName("/foto.jpg")).toBe("foto.jpg");
    expect(imageFileName("images/foto.jpg")).toBe("foto.jpg");
    expect(imageFileName("/images/foto.jpg")).toBe("foto.jpg");
    expect(imageFileName("foto.jpg")).toBe("foto.jpg");
  });

  it("accepts a name with two dots in a row: without a separator it goes nowhere", () => {
    // The uploader used to keep the original name unsanitised, so a photograph
    // called "foto..jpg" or "…10.20.30 a. m..png" is stored as "…_foto..webp".
    // Refusing it made the Archivos screen call a photograph in use an orphan.
    expect(imageFileName("/1712428860328_foto..webp")).toBe("1712428860328_foto..webp");
    expect(imageFileName("images/captura a. m..webp")).toBe("captura a. m..webp");
    expect(resolveImagePath("/1712428860328_foto..webp", ROOT))
      .toBe(path.join(ROOT, "1712428860328_foto..webp"));
  });

  it("still refuses the two names that are navigation by themselves", () => {
    expect(imageFileName("..")).toBeNull();
    expect(imageFileName(".")).toBeNull();
    expect(imageFileName("/..")).toBeNull();
    expect(imageFileName("images/..")).toBeNull();
  });

  it("answers null for anything that is not a plain name", () => {
    expect(imageFileName("../x.jpg")).toBeNull();
    expect(imageFileName("a/b.jpg")).toBeNull();
    expect(imageFileName("")).toBeNull();
    expect(imageFileName(null)).toBeNull();
    expect(imageFileName(42)).toBeNull();
  });
});

describe("resolveImagePath", () => {
  it("accepts a stored value as it appears in the database", () => {
    // Uploads are recorded with a leading slash and no directory.
    expect(resolveImagePath("/1778185422691_foto.webp", ROOT))
      .toBe(path.join(ROOT, "1778185422691_foto.webp"));
  });

  it("accepts a bare name too", () => {
    expect(resolveImagePath("foto.jpg", ROOT)).toBe(path.join(ROOT, "foto.jpg"));
  });

  it("accepts the older images/ prefix still present in the data", () => {
    // 424 of the 3.514 stored photographs carry it. Refusing them would have
    // left twelve per cent of the images out of every export, silently.
    expect(resolveImagePath("images/foto.jpg", ROOT)).toBe(path.join(ROOT, "foto.jpg"));
    expect(resolveImagePath("/images/foto.jpg", ROOT)).toBe(path.join(ROOT, "foto.jpg"));
    expect(resolveImagePath("IMAGES/foto.jpg", ROOT)).toBe(path.join(ROOT, "foto.jpg"));
    expect(resolveImagePath("images\\foto.jpg", ROOT)).toBe(path.join(ROOT, "foto.jpg"));
  });

  it("still refuses traversal hidden behind that prefix", () => {
    // Only the leading run is stripped; whatever is left faces every check.
    expect(resolveImagePath("images/../secreto.env", ROOT)).toBeNull();
    expect(resolveImagePath("images/images/../../dist/index.js", ROOT)).toBeNull();
    expect(resolveImagePath("images/sub/foto.jpg", ROOT)).toBeNull();
    expect(resolveImagePath("images/", ROOT)).toBeNull();
  });

  it("does not strip images/ from the middle of a name", () => {
    expect(resolveImagePath("foto-images/x.jpg", ROOT)).toBeNull();
  });

  it("refuses the traversal Express hands over decoded", () => {
    // DELETE /api/files/..%2F..%2Fdist%2Findex.js arrived as this string and
    // used to reach unlinkSync, letting an administrator delete the server.
    expect(resolveImagePath("../../dist/index.js", ROOT)).toBeNull();
    expect(resolveImagePath("..\\..\\dist\\index.js", ROOT)).toBeNull();
    expect(resolveImagePath("/../etc/passwd", ROOT)).toBeNull();
  });

  it("refuses anything that names a directory", () => {
    expect(resolveImagePath("sub/foto.jpg", ROOT)).toBeNull();
    expect(resolveImagePath("sub\\foto.jpg", ROOT)).toBeNull();
  });

  it("refuses an absolute path that would escape the directory", () => {
    expect(resolveImagePath("/etc/passwd", ROOT)).toBeNull();
    expect(resolveImagePath("C:/Windows/System32/config", ROOT)).toBeNull();
    expect(resolveImagePath("\\\\servidor\\recurso", ROOT)).toBeNull();
  });

  it("refuses a NUL byte, which truncates the name for the syscall", () => {
    expect(resolveImagePath("foto.jpg\0.txt", ROOT)).toBeNull();
  });

  it("refuses what is not a name at all", () => {
    for (const value of [null, undefined, "", "   ", "/", "//", 42, {}, []]) {
      expect(resolveImagePath(value, ROOT)).toBeNull();
    }
  });

  it("does not treat a dot inside the name as traversal", () => {
    expect(resolveImagePath("2026.08.06_foto.jpg", ROOT))
      .toBe(path.join(ROOT, "2026.08.06_foto.jpg"));
  });

  it("refuses a name containing .. even when it would resolve inside", () => {
    // "a/../b" resolves back inside, but a name is a name: no navigation at all.
    expect(resolveImagePath("a/../foto.jpg", ROOT)).toBeNull();
  });
});
