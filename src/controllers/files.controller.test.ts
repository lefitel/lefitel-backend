// The Archivos screen, fed the data it actually has: two spellings of one name.
//
// 3.090 stored image values look like "/foto.jpg" and 424 look like
// "images/foto.jpg" — an older upload path that survived. The first version of
// `files.controller.ts` indexed the disk as `/${name}` and the database as the
// raw stored string, so the 424 never matched a file: "delete orphans" would
// have unlinked all of them and "clear broken references" would have nulled all
// of their rows. Every case below carries one value of each shape, so a return
// to comparing raw strings fails here on the second one.
//
// The five model modules are mocked whole and `fs.promises` is spied: nothing
// here reads a disk or a database, which matters because the database this
// environment is configured with is a copy of production.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import fs from "fs";
import path from "node:path";

const findAll = {
  poste: vi.fn(),
  evento: vi.fn(),
  ciudad: vi.fn(),
  usuario: vi.fn(),
  solucion: vi.fn(),
};
vi.mock("../models/poste.model.js", () => ({ PosteModel: { findAll: (...a: unknown[]) => findAll.poste(...a) } }));
vi.mock("../models/evento.model.js", () => ({ EventoModel: { findAll: (...a: unknown[]) => findAll.evento(...a) } }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: { findAll: (...a: unknown[]) => findAll.ciudad(...a) } }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: { findAll: (...a: unknown[]) => findAll.usuario(...a) } }));
vi.mock("../models/solucion.model.js", () => ({ SolucionModel: { findAll: (...a: unknown[]) => findAll.solucion(...a) } }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));

const {
  getOrphanFiles, deleteOrphanFiles, getBrokenImageRefs, clearBrokenImageRefs, getEntityImageStats,
} = await import("./files.controller.js");

const readdir = vi.spyOn(fs.promises, "readdir");
const stat = vi.spyOn(fs.promises, "stat");
const unlink = vi.spyOn(fs.promises, "unlink");

/** A row as Sequelize hands it back, with the `update` the cleaner calls. */
const fila = (values: Record<string, unknown>) => ({ dataValues: values, update: vi.fn().mockResolvedValue(undefined) });

const reqOf = () => ({ user: { id: 1, id_rol: 1 } }) as unknown as Request;
const resOf = () => {
  const res = { status: vi.fn(), json: vi.fn(), sendStatus: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { json: ReturnType<typeof vi.fn> };
};

/** What one call answered with. */
const cuerpo = (res: Response) => (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

// On disk: three files. In the database: `a` named the new way by a pole, `b`
// named the OLD way by an event — the 424 — and nothing names `c`. A fourth
// name, `zz`, is stored by a user and is not on disk: the one genuinely broken
// reference.
const EN_DISCO = ["a.jpg", "b.jpg", "c.jpg"];
let poste: ReturnType<typeof fila>;
let evento: ReturnType<typeof fila>;
let usuario: ReturnType<typeof fila>;

beforeEach(() => {
  vi.clearAllMocks();
  readdir.mockResolvedValue(EN_DISCO as never);
  stat.mockResolvedValue({ size: 10, birthtime: new Date("2026-01-01") } as never);
  unlink.mockResolvedValue(undefined);

  poste = fila({ id: 1, image: "/a.jpg", name: "P-1" });
  evento = fila({ id: 2, image: "images/b.jpg" });
  usuario = fila({ id: 3, image: "/zz.jpg", name: "Ana", lastname: "Ruiz" });
  findAll.poste.mockResolvedValue([poste]);
  findAll.evento.mockResolvedValue([evento]);
  findAll.ciudad.mockResolvedValue([]);
  findAll.usuario.mockResolvedValue([usuario]);
  findAll.solucion.mockResolvedValue([]);
});

describe("orphans", () => {
  it("recognises a file stored under the old images/ prefix as in use", async () => {
    const res = resOf();
    await getOrphanFiles(reqOf(), res);

    const porNombre = Object.fromEntries((cuerpo(res) as { name: string; isOrphan: boolean; usedBy: unknown }[]).map((f) => [f.name, f]));
    expect(porNombre["a.jpg"].isOrphan).toBe(false);
    // The one the raw comparison called an orphan.
    expect(porNombre["b.jpg"].isOrphan).toBe(false);
    expect(porNombre["b.jpg"].usedBy).toMatchObject({ type: "Evento", id: 2 });
    expect(porNombre["c.jpg"].isOrphan).toBe(true);
  });

  it("deletes only the file nothing names", async () => {
    const res = resOf();
    await deleteOrphanFiles(reqOf(), res);

    // One unlink, and it is `c`. Under the raw comparison `b` went too — 424
    // referenced photographs, on one press of the button.
    expect(unlink).toHaveBeenCalledOnce();
    expect(path.basename(String(unlink.mock.calls[0][0]))).toBe("c.jpg");
    expect(cuerpo(res)).toEqual({ deleted: 1, files: ["c.jpg"] });
  });

  it("still keeps what the client renders: a leading-slash path per file", async () => {
    // The screen links `path`; only the comparison changed.
    const res = resOf();
    await getOrphanFiles(reqOf(), res);
    expect((cuerpo(res) as { path: string }[]).map((f) => f.path).sort()).toEqual(["/a.jpg", "/b.jpg", "/c.jpg"]);
  });
});

describe("broken references", () => {
  it("reports only the row whose file is really missing", async () => {
    const res = resOf();
    await getBrokenImageRefs(reqOf(), res);

    // `images/b.jpg` is on disk as `b.jpg`. Under the raw comparison it was
    // reported broken alongside `zz`.
    expect(cuerpo(res)).toEqual([{ tipo: "Usuario", id: 3, name: "Ana Ruiz", image: "/zz.jpg" }]);
  });

  it("nulls only the row whose file is really missing", async () => {
    const res = resOf();
    await clearBrokenImageRefs(reqOf(), res);

    expect(usuario.update).toHaveBeenCalledWith({ image: null });
    expect(evento.update).not.toHaveBeenCalled();
    expect(poste.update).not.toHaveBeenCalled();
    expect(cuerpo(res)).toEqual({ cleared: 1 });
  });

  it("counts the same way in the summary", async () => {
    const res = resOf();
    await getEntityImageStats(reqOf(), res);

    const stats = cuerpo(res) as Record<string, { referenciaRota: number }>;
    expect(stats.eventos.referenciaRota).toBe(0);
    expect(stats.usuarios.referenciaRota).toBe(1);
  });

  it("treats a stored value that names no plain file as broken", async () => {
    // Traversal in a stored value points at nothing inside IMAGES_DIR; the
    // honest answer is "broken", not "fine because we could not compare it".
    findAll.ciudad.mockResolvedValue([fila({ id: 9, image: "../../etc/passwd", name: "X" })]);
    const res = resOf();
    await getBrokenImageRefs(reqOf(), res);
    expect(cuerpo(res)).toContainEqual(expect.objectContaining({ tipo: "Ciudad", id: 9 }));
  });
});
