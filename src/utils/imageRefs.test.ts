// A photograph is deleted only when nothing names it any more.
//
// The hole this closes: every controller that replaced a photograph deleted
// "the old one" on the row's word alone, and the row's word came from a PUT. So
// `PUT /api/usuario/7 {image: "/foto-de-un-evento.jpg"}` followed by a second
// PUT with any other name removed a file that belonged to an incident — from
// the least-privileged account, on its own profile. What is asserted here is
// the rule that replaces that: ask the five tables first, archived rows
// included, and unlink only on silence.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs";
import path from "node:path";

const counts = {
  poste: vi.fn(),
  evento: vi.fn(),
  ciudad: vi.fn(),
  usuario: vi.fn(),
  solucion: vi.fn(),
};
vi.mock("../models/poste.model.js", () => ({ PosteModel: { count: (...a: unknown[]) => counts.poste(...a) } }));
vi.mock("../models/evento.model.js", () => ({ EventoModel: { count: (...a: unknown[]) => counts.evento(...a) } }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: { count: (...a: unknown[]) => counts.ciudad(...a) } }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: { count: (...a: unknown[]) => counts.usuario(...a) } }));
vi.mock("../models/solucion.model.js", () => ({ SolucionModel: { count: (...a: unknown[]) => counts.solucion(...a) } }));

const { deleteImageIfUnreferenced, isImageReferenced, spellingsOf } = await import("./imageRefs.js");
const { IMAGES_DIR } = await import("./fileUtils.js");

const unlink = vi.spyOn(fs.promises, "unlink");

beforeEach(() => {
  vi.clearAllMocks();
  for (const c of Object.values(counts)) c.mockResolvedValue(0);
  unlink.mockResolvedValue(undefined);
});

describe("deleteImageIfUnreferenced", () => {
  it("deletes a file nothing names", async () => {
    const r = await deleteImageIfUnreferenced("/1712428860328_210.jpg");
    expect(r).toBe("borrado");
    expect(unlink).toHaveBeenCalledOnce();
    expect(path.basename(String(unlink.mock.calls[0][0]))).toBe("1712428860328_210.jpg");
  });

  it("keeps a file another table still names — the attack, exactly", async () => {
    // The attacker's own row was just saved with a new portrait, so `usuario`
    // answers 0. The victim's incident still names the file, so `evento` does
    // not. That single non-zero is what stands between the file and unlink.
    counts.evento.mockResolvedValue(1);
    const r = await deleteImageIfUnreferenced("/1712428860328_210.jpg");
    expect(r).toBe("en uso");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("asks every one of the five tables, including archived rows", async () => {
    await deleteImageIfUnreferenced("/foto.jpg");
    for (const [tabla, c] of Object.entries(counts)) {
      expect(c, tabla).toHaveBeenCalledOnce();
      // `paranoid: false`: an archived pole still has a photograph, and the
      // Archivos screen already counts archived rows as owners. The two rules
      // have to agree or the orphan cleaner and this would delete each other's
      // files.
      expect(c.mock.calls[0][0], tabla).toMatchObject({ paranoid: false });
    }
  });

  it("looks for every spelling the data has used for one name", async () => {
    // 3.090 rows say "/foto.jpg", 424 say "images/foto.jpg". A file referenced
    // under the second spelling is as much in use as under the first.
    counts.ciudad.mockImplementation(async (opts: { where: { image: { [k: symbol]: string[] } } }) => {
      const lista = Object.getOwnPropertySymbols(opts.where.image).map((s) => opts.where.image[s])[0];
      return lista.includes("images/foto.jpg") ? 1 : 0;
    });
    expect(await deleteImageIfUnreferenced("/foto.jpg")).toBe("en uso");
    expect(unlink).not.toHaveBeenCalled();
    expect(spellingsOf("foto.jpg")).toEqual(["foto.jpg", "/foto.jpg", "images/foto.jpg", "/images/foto.jpg"]);
  });

  it("refuses a value that is not a plain file name, without asking or unlinking", async () => {
    expect(await deleteImageIfUnreferenced("../../dist/index.js")).toBe("inválido");
    expect(await deleteImageIfUnreferenced(null)).toBe("inválido");
    expect(await deleteImageIfUnreferenced("")).toBe("inválido");
    expect(unlink).not.toHaveBeenCalled();
    expect(counts.poste).not.toHaveBeenCalled();
  });

  it("swallows a database failure and reports it, rather than rejecting", async () => {
    // Callers fire this without awaiting. An unhandled rejection from that
    // promise would take the process down, so a failure here has to come back
    // as a value.
    counts.usuario.mockRejectedValue(new Error("connection reset"));
    await expect(deleteImageIfUnreferenced("/foto.jpg")).resolves.toBe("error");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not fail when the file is already gone", async () => {
    unlink.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(deleteImageIfUnreferenced("/foto.jpg")).resolves.toBe("borrado");
  });

  it("resolves the file inside IMAGES_DIR, never elsewhere", async () => {
    await deleteImageIfUnreferenced("images/foto.jpg");
    const target = String(unlink.mock.calls[0][0]);
    expect(target.startsWith(path.resolve(IMAGES_DIR))).toBe(true);
  });
});

describe("isImageReferenced", () => {
  it("is false for a name nothing stores, without a query", async () => {
    expect(await isImageReferenced("a/b")).toBe(false);
    expect(counts.poste).not.toHaveBeenCalled();
  });
});

describe("no controller deletes a photograph on the row's word alone", () => {
  // Source-level, and small: the five call sites that used to call
  // `deleteImageFile(old)` now call this module, and the sixth controller that
  // somebody writes by copying one of them must too. `deleteImageFile` itself
  // is gone from `fileUtils.ts`; this is what notices if it comes back.
  const controllers = dirname(fileURLToPath(import.meta.url)).replace(/utils$/, "controllers");

  it("calls deleteImageIfUnreferenced and nothing older", () => {
    const files = readdirSync(controllers).filter((f) => f.endsWith(".controller.ts"));
    const viejos = files.filter((f) => /\bdeleteImageFile\s*\(/.test(readFileSync(join(controllers, f), "utf8")));
    expect(viejos, "estos controladores borran la foto anterior sin preguntar a la base de datos").toEqual([]);

    const nuevos = files.filter((f) => /\bdeleteImageIfUnreferenced\s*\(/.test(readFileSync(join(controllers, f), "utf8")));
    expect(new Set(nuevos)).toEqual(new Set([
      "ciudad.controller.ts",
      "evento.controller.ts",
      "poste.controller.ts",
      "usuario.controller.ts",
    ]));
  });

  it("only the Archivos screen unlinks a file directly", () => {
    const files = readdirSync(controllers).filter((f) => f.endsWith(".controller.ts"));
    const directos = files.filter((f) => /\bunlink(?:Sync)?\s*\(/.test(readFileSync(join(controllers, f), "utf8")));
    // `deleteFile` (an administrator naming one file) and `deleteOrphanFiles`
    // (the cleaner, which asks the same question this module asks).
    expect(directos).toEqual(["files.controller.ts"]);
  });
});
