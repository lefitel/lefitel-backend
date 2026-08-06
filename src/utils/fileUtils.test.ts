import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveImagePath } from "./fileUtils.js";

const ROOT = path.resolve("/tmp/osefi-images");

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
