// Archiving and unarchiving that know whether anything happened.
//
// Seventeen handlers called `destroy`/`restore` and then wrote "Archivó … #id"
// to the audit log whatever the outcome. Neither call fails when nothing
// matches, so archiving a record that does not exist answered 204 and left a
// `critical` line about it. The second half of this file reads the controllers
// themselves, because the helper being right is no use to a handler that does
// not call it.

import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ModelStatic } from "sequelize";
import { archivar, desarchivar } from "./archivado.js";

const modelo = (over: Record<string, unknown>) => ({
  destroy: vi.fn().mockResolvedValue(0),
  restore: vi.fn().mockResolvedValue(undefined),
  findOne: vi.fn().mockResolvedValue(null),
  ...over,
}) as unknown as ModelStatic<Model> & { destroy: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };

const filaCon = (deletedAt: Date | null) => ({ get: (campo: string) => (campo === "deletedAt" ? deletedAt : 5) });

describe("archivar", () => {
  it("says yes when a row was archived", async () => {
    expect(await archivar(modelo({ destroy: vi.fn().mockResolvedValue(1) }), "5")).toBe(true);
  });

  it("says no when there was no such row, or it was archived already", async () => {
    // Both come back as zero rows from a paranoid `destroy`.
    expect(await archivar(modelo({}), "99999")).toBe(false);
  });
});

describe("desarchivar", () => {
  it("restores a row that is archived", async () => {
    const m = modelo({ findOne: vi.fn().mockResolvedValue(filaCon(new Date())) });

    expect(await desarchivar(m, "5")).toBe(true);
    expect(m.restore).toHaveBeenCalledTimes(1);
    // Looked for among the archived ones: a default query would never see it.
    expect(m.findOne.mock.calls[0][0]).toMatchObject({ paranoid: false });
  });

  it("says no, and restores nothing, when the row is not archived", async () => {
    const m = modelo({ findOne: vi.fn().mockResolvedValue(filaCon(null)) });

    expect(await desarchivar(m, "5")).toBe(false);
    expect(m.restore).not.toHaveBeenCalled();
  });

  it("says no when there is no such row", async () => {
    const m = modelo({});

    expect(await desarchivar(m, "99999")).toBe(false);
    expect(m.restore).not.toHaveBeenCalled();
  });
});

describe("no handler writes an archive line without knowing a row changed", () => {
  const CONTROLADORES = join(dirname(fileURLToPath(import.meta.url)), "../controllers");
  const fuentes = readdirSync(CONTROLADORES)
    .filter((f) => f.endsWith(".controller.ts"))
    .map((f) => ({ f, texto: readFileSync(join(CONTROLADORES, f), "utf8") }));

  it("se leyeron los controladores", () => {
    expect(fuentes.length).toBeGreaterThan(15);
  });

  it("ninguno archiva ni desarchiva por id y anota en la línea siguiente", () => {
    // The shape of the defect, exactly: the bare call, its result dropped, and
    // `logAction` straight after.
    const patron = /await \w+Model\.(destroy|restore)\(\{ where: \{ id \} \}\);\s*\n\s*logAction\(/g;
    const culpables = fuentes
      .map(({ f, texto }) => ({ f, veces: (texto.match(patron) ?? []).length }))
      .filter(({ veces }) => veces > 0);
    // One, and it is not the defect: restoring an account looks the row up
    // among the archived first and answers 404 when it is not there — it also
    // has a name collision to check that the shared helper knows nothing about.
    // Pinned as a pair, file and count, so a second bare call in that file is
    // not covered by this exemption.
    expect(culpables).toEqual([{ f: "usuario.controller.ts", veces: 1 }]);
    const usuario = fuentes.find(({ f }) => f === "usuario.controller.ts")!.texto;
    const hasta = usuario.indexOf("await UsuarioModel.restore({ where: { id } });");
    expect(usuario.slice(hasta - 1500, hasta)).toMatch(/if \(!archivado\) return res\.status\(404\)/);
  });

  it("los que usan la pieza compartida responden 404 cuando no había nada", () => {
    const usos = fuentes.flatMap(({ f, texto }) =>
      Array.from(texto.matchAll(/^.*await (archivar|desarchivar)\(.*$/gm), (m) => ({ f, linea: m[0] })));
    expect(usos.length, "no se encontró ningún uso").toBeGreaterThanOrEqual(17);
    const sinRespuesta = usos.filter(({ linea }) => !/if \(!\(await (archivar|desarchivar)\(.*\)\)\) return res\.status\(404\)/.test(linea));
    expect(sinRespuesta).toEqual([]);
  });
});
