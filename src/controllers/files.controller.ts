// The Archivos screen: what is on disk, what the database names, and the two
// buttons that reconcile them.
//
// Everything here compares a stored image value with a file name on disk, and
// the comparison is the whole job. Stored values come in two shapes — "/foto.jpg"
// for most rows and "images/foto.jpg" for 424 that survived an older upload
// path — and the first version of this file compared the raw string with
// `/${name}`. The 424 never matched. So "delete orphans" would have unlinked
// every one of those photographs, and "clear broken references" would have
// nulled every one of those rows, each with a bitácora line saying the
// administrator asked for it. An audit found it on 3 September, before anybody
// pressed either button. Both sides go through `imageFileName()` now, and the
// test beside this file feeds it the mixed data.

import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { CiudadModel } from "../models/ciudad.model.js";
import { EventoModel } from "../models/evento.model.js";
import { PosteModel } from "../models/poste.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { IMAGES_DIR, imageFileName, resolveImagePath } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const filesLog = log("files");
const handler = makeHandler(filesLog);

interface FileInfo {
  name: string;
  path: string;
  size: number;
  createdAt: Date;
}

interface FileUsage {
  type: string;
  id: number;
  name: string;
}

/**
 * Every stored image value across the five tables, keyed by the bare file name
 * it refers to. Archived rows included: an archived pole still has a
 * photograph, and the cleaner must not take it.
 *
 * A stored value that does not resolve to a plain name — traversal, empty —
 * is left out of the map: it names no file on disk, so it cannot protect one.
 */
async function getAllDbImageMap(): Promise<Map<string, FileUsage>> {
  const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
    PosteModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
    EventoModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    CiudadModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
    UsuarioModel.findAll({ attributes: ["id", "image", "name", "lastname"], paranoid: false }),
    SolucionModel.findAll({ attributes: ["id", "image", "id_evento"], paranoid: false }),
  ]);

  const map = new Map<string, FileUsage>();
  const set = (stored: unknown, usage: FileUsage) => {
    const name = imageFileName(stored);
    if (name !== null) map.set(name, usage);
  };
  for (const p of postes)
    set(p.dataValues.image, { type: "Poste", id: p.dataValues.id, name: p.dataValues.name });
  for (const e of eventos)
    set(e.dataValues.image, { type: "Evento", id: e.dataValues.id, name: `Evento #${e.dataValues.id}` });
  for (const c of ciudades)
    set(c.dataValues.image, { type: "Ciudad", id: c.dataValues.id, name: c.dataValues.name });
  for (const u of usuarios)
    set(u.dataValues.image, { type: "Usuario", id: u.dataValues.id, name: `${u.dataValues.name} ${u.dataValues.lastname}` });
  for (const s of soluciones)
    set(s.dataValues.image, { type: "Solución", id: s.dataValues.id_evento, name: `Evento #${s.dataValues.id_evento}` });
  return map;
}

/**
 * What the images directory holds, or why it could not be read.
 *
 * 🔴 **"Could not read" and "is empty" are not the same answer, and treating
 * them as one is a data-loss defect.** Every reader here decides what is an
 * orphan or a broken reference by comparing the database against this list. An
 * empty list makes *every* stored value look broken — so `clearBrokenImageRefs`,
 * which writes `image: null` on every row it thinks is broken, would empty the
 * photograph column of `postes`, `eventos`, `ciudads`, `usuarios` and
 * `solucions` in one request. The files would still be on disk; nothing would
 * name them, and there is no way back.
 *
 * The scenario is not hypothetical and it is not rare: `IMAGES_DIR` must be a
 * volume the host mounts (see `fileUtils.ts`), and a first deploy where that
 * mount is missing or misspelled is exactly when an administrator opens the
 * Archivos screen, sees every image listed as a broken reference, and presses
 * the button the screen is offering. The mount failing "up" — an empty directory
 * where the volume should be — reads as success from `readdir`, which is why
 * emptiness is guarded below as well as failure.
 */
type Disco =
  | { legible: true; ficheros: FileInfo[] }
  | { legible: false; motivo: string };

async function leerDisco(): Promise<Disco> {
  try {
    const names = await fs.promises.readdir(IMAGES_DIR);
    const ficheros = await Promise.all(
      names.map(async (name) => {
        const stats = await fs.promises.stat(path.join(IMAGES_DIR, name));
        // `path` is what the client renders and links; comparisons below use
        // `name`, never `path`.
        return { name, path: `/${name}`, size: stats.size, createdAt: stats.birthtime };
      })
    );
    return { legible: true, ficheros };
  } catch (error) {
    return { legible: false, motivo: (error as { code?: string })?.code ?? "desconocido" };
  }
}

/**
 * The lenient reader, for the two callers where "nothing on disk" is a true and
 * harmless answer: listing files, and counting them per entity. Neither writes.
 */
async function readDiskFiles(): Promise<FileInfo[]> {
  const disco = await leerDisco();
  return disco.legible ? disco.ficheros : [];
}

/** The bare names on disk, for "does this stored value point at a real file". */
const diskNames = async () => new Set((await readDiskFiles()).map((f) => f.name));

/**
 * Whether a stored value names a file that is not on disk. A value that does not
 * resolve to a plain name at all is broken too: it points nowhere.
 */
const rotaSegun = (disk: Set<string>) => (stored: unknown): boolean => {
  if (!stored) return false;
  const name = imageFileName(stored);
  return name === null || !disk.has(name);
};

export const getOrphanFiles = handler("getOrphanFiles", async (req: Request, res: Response) => {
  const [files, dbMap] = await Promise.all([
    readDiskFiles(),
    getAllDbImageMap(),
  ]);
  const result = files.map((f) => {
    const usage = dbMap.get(f.name) ?? null;
    return { ...f, isOrphan: !usage, usedBy: usage };
  });
  res.status(200).json(result);
});

export const deleteFile = handler("deleteFile", async (req: Request, res: Response) => {
  const name = req.params.name as string;
  // Express decodes %2F inside a route parameter, so the name arrived here able
  // to climb out of the images directory and unlinkSync obeyed.
  const fullPath = resolveImagePath(name);
  if (fullPath === null) {
    return res.status(400).json({ message: "Nombre de archivo inválido." });
  }

  fs.unlinkSync(fullPath);
  logAction({ id_usuario: req.user?.id, action: "DELETE_FILE", entity: "File", entity_id: null, detail: `Eliminó archivo ${name}`, metadata: { filename: name }, severity: 'critical' });
  res.status(204).end();
});

export const getEntityImageStats = handler("getEntityImageStats", async (req: Request, res: Response) => {
  const rota = rotaSegun(await diskNames());

  const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
    PosteModel.findAll({ attributes: ["image"], paranoid: false }),
    EventoModel.findAll({ attributes: ["image"], paranoid: false }),
    CiudadModel.findAll({ attributes: ["image"], paranoid: false }),
    UsuarioModel.findAll({ attributes: ["image"], paranoid: false }),
    SolucionModel.findAll({ attributes: ["image"], paranoid: false }),
  ]);

  const summarize = (rows: { dataValues: { image?: string | null } }[]) => {
    let sinImagen = 0, referenciaRota = 0;
    for (const r of rows) {
      const img = r.dataValues.image;
      if (!img) sinImagen++;
      else if (rota(img)) referenciaRota++;
    }
    return { total: rows.length, sinImagen, referenciaRota };
  };

  res.status(200).json({
    postes:    summarize(postes),
    eventos:   summarize(eventos),
    ciudades:  summarize(ciudades),
    usuarios:  summarize(usuarios),
    soluciones: summarize(soluciones),
  });
});

/**
 * The refusal the two broken-reference routes share.
 *
 * Returns the set of names on disk, or a response already sent. Two refusals,
 * and the second is the one that catches the real accident:
 *
 *   - the directory could not be read at all — `503`, because it is a
 *     dependency being unavailable and retrying is the right next move;
 *   - the directory is readable and **empty while the database holds
 *     references** — `409`. A volume that failed to mount usually leaves an
 *     empty directory behind rather than an error, so this is what the first
 *     deploy actually looks like. Ten thousand broken references and zero files
 *     is not a cleanup job; it is a mount problem, and the message says so.
 *
 * Nothing is written in either case, and the sentence says that too: an
 * administrator who reads "no se ha modificado nada" does not go looking for
 * what was half-done.
 */
const nombresEnDiscoOFallo = async (
  res: Response,
  referencias: number,
): Promise<Set<string> | null> => {
  const disco = await leerDisco();
  if (!disco.legible) {
    res.status(503).json({
      message:
        "No se pudo leer el directorio de imágenes, así que no hay forma de saber qué " +
        "referencias están rotas. No se ha modificado nada.",
    });
    return null;
  }
  if (disco.ficheros.length === 0 && referencias > 0) {
    res.status(409).json({
      message:
        `El directorio de imágenes está vacío y la base de datos tiene ${referencias} ` +
        "referencias. Eso parece un volumen sin montar, no referencias rotas. No se ha " +
        "modificado nada.",
      referencias,
    });
    return null;
  }
  return new Set(disco.ficheros.map((f) => f.name));
};

export const getBrokenImageRefs = handler("getBrokenImageRefs", async (req: Request, res: Response) => {
  const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
    PosteModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
    EventoModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    CiudadModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
    UsuarioModel.findAll({ attributes: ["id", "image", "name", "lastname"], paranoid: false }),
    SolucionModel.findAll({ attributes: ["id", "image", "id_evento"], paranoid: false }),
  ]);

  // The listing refuses on the same two conditions as the button below, and
  // that is deliberate: this is what the screen draws, and a screen listing
  // every photograph in the company as broken is what invites the click.
  const referencias = [postes, eventos, ciudades, usuarios, soluciones]
    .flat().filter((r) => (r.dataValues as { image?: unknown }).image).length;
  const disco = await nombresEnDiscoOFallo(res, referencias);
  if (!disco) return;
  const rota = rotaSegun(disco);

  const broken: { tipo: string; id: number; name: string; image: string }[] = [];

  for (const p of postes)
    if (rota(p.dataValues.image))
      broken.push({ tipo: "Poste", id: p.dataValues.id, name: p.dataValues.name, image: p.dataValues.image });
  for (const e of eventos)
    if (rota(e.dataValues.image))
      broken.push({ tipo: "Evento", id: e.dataValues.id, name: `Evento #${e.dataValues.id}`, image: e.dataValues.image });
  for (const c of ciudades)
    if (rota(c.dataValues.image))
      broken.push({ tipo: "Ciudad", id: c.dataValues.id, name: c.dataValues.name, image: c.dataValues.image });
  for (const u of usuarios)
    if (rota(u.dataValues.image))
      broken.push({ tipo: "Usuario", id: u.dataValues.id, name: `${u.dataValues.name} ${u.dataValues.lastname}`, image: u.dataValues.image });
  for (const s of soluciones)
    if (rota(s.dataValues.image))
      broken.push({ tipo: "Solución", id: s.dataValues.id_evento, name: `Evento #${s.dataValues.id_evento}`, image: s.dataValues.image });

  res.status(200).json(broken);
});

export const clearBrokenImageRefs = handler("clearBrokenImageRefs", async (req: Request, res: Response) => {
  const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
    PosteModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    EventoModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    CiudadModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    UsuarioModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    SolucionModel.findAll({ attributes: ["id", "image"], paranoid: false }),
  ]);

  // 🔴 The guard, before a single row is written. This is the only route in the
  // API that can empty a column across five tables in one request.
  const referencias = [postes, eventos, ciudades, usuarios, soluciones]
    .flat().filter((r) => (r.dataValues as { image?: unknown }).image).length;
  const disco = await nombresEnDiscoOFallo(res, referencias);
  if (!disco) return;
  const rota = rotaSegun(disco);

  let cleared = 0;

  await Promise.all([
    ...postes.filter((r) => rota(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
    ...eventos.filter((r) => rota(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
    ...ciudades.filter((r) => rota(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
    ...usuarios.filter((r) => rota(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
    ...soluciones.filter((r) => rota(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
  ]);

  logAction({ id_usuario: req.user?.id, action: "CLEAR_BROKEN_REFS", entity: "File", entity_id: null, detail: `Limpió ${cleared} referencias rotas de imágenes`, metadata: { cleared }, severity: 'warning' });
  res.status(200).json({ cleared });
});

export const deleteOrphanFiles = handler("deleteOrphanFiles", async (req: Request, res: Response) => {
  const [files, dbMap] = await Promise.all([
    readDiskFiles(),
    getAllDbImageMap(),
  ]);
  const orphans = files.filter((f) => !dbMap.has(f.name));
  await Promise.all(orphans.map((f) => fs.promises.unlink(path.join(IMAGES_DIR, f.name))));
  logAction({ id_usuario: req.user?.id, action: "DELETE_ORPHANS", entity: "File", entity_id: null, detail: `Eliminó ${orphans.length} archivos huérfanos`, metadata: { deleted: orphans.length, files: orphans.map((f) => f.name) }, severity: 'warning' });
  res.status(200).json({ deleted: orphans.length, files: orphans.map((f) => f.name) });
});
