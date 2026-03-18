import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { CiudadModel } from "../models/ciudad.model.js";
import { EventoModel } from "../models/evento.model.js";
import { PosteModel } from "../models/poste.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { IMAGES_DIR } from "../utils/fileUtils.js";

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

async function getAllDbImageMap(): Promise<Map<string, FileUsage>> {
  const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
    PosteModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
    EventoModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    CiudadModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
    UsuarioModel.findAll({ attributes: ["id", "image", "name", "lastname"], paranoid: false }),
    SolucionModel.findAll({ attributes: ["id", "image", "id_evento"], paranoid: false }),
  ]);

  const map = new Map<string, FileUsage>();
  for (const p of postes)
    if (p.dataValues.image) map.set(p.dataValues.image, { type: "Poste", id: p.dataValues.id, name: p.dataValues.name });
  for (const e of eventos)
    if (e.dataValues.image) map.set(e.dataValues.image, { type: "Evento", id: e.dataValues.id, name: `Evento #${e.dataValues.id}` });
  for (const c of ciudades)
    if (c.dataValues.image) map.set(c.dataValues.image, { type: "Ciudad", id: c.dataValues.id, name: c.dataValues.name });
  for (const u of usuarios)
    if (u.dataValues.image) map.set(u.dataValues.image, { type: "Usuario", id: u.dataValues.id, name: `${u.dataValues.name} ${u.dataValues.lastname}` });
  for (const s of soluciones)
    if (s.dataValues.image) map.set(s.dataValues.image, { type: "Solución", id: s.dataValues.id_evento, name: `Evento #${s.dataValues.id_evento}` });
  return map;
}

async function readDiskFiles(): Promise<FileInfo[]> {
  try {
    const names = await fs.promises.readdir(IMAGES_DIR);
    return await Promise.all(
      names.map(async (name) => {
        const stats = await fs.promises.stat(path.join(IMAGES_DIR, name));
        return { name, path: `/${name}`, size: stats.size, createdAt: stats.birthtime };
      })
    );
  } catch {
    return [];
  }
}

export async function getFiles(req: Request, res: Response) {
  try {
    const files = await readDiskFiles();
    res.status(200).json(files);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getOrphanFiles(req: Request, res: Response) {
  try {
    const [files, dbMap] = await Promise.all([
      readDiskFiles(),
      getAllDbImageMap(),
    ]);
    const result = files.map((f) => {
      const usage = dbMap.get(f.path) ?? null;
      return { ...f, isOrphan: !usage, usedBy: usage };
    });
    res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteFile(req: Request, res: Response) {
  const name = req.params.name as string;
  try {
    fs.unlinkSync(path.join(IMAGES_DIR, name));
    res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getEntityImageStats(req: Request, res: Response) {
  try {
    const diskFiles = await readDiskFiles();
    const diskSet = new Set(diskFiles.map((f) => f.path));

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
        else if (!diskSet.has(img)) referenciaRota++;
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
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getBrokenImageRefs(req: Request, res: Response) {
  try {
    const diskSet = new Set((await readDiskFiles()).map((f) => f.path));

    const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
      PosteModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
      EventoModel.findAll({ attributes: ["id", "image"], paranoid: false }),
      CiudadModel.findAll({ attributes: ["id", "image", "name"], paranoid: false }),
      UsuarioModel.findAll({ attributes: ["id", "image", "name", "lastname"], paranoid: false }),
      SolucionModel.findAll({ attributes: ["id", "image", "id_evento"], paranoid: false }),
    ]);

    const broken: { tipo: string; id: number; name: string; image: string }[] = [];

    for (const p of postes)
      if (p.dataValues.image && !diskSet.has(p.dataValues.image))
        broken.push({ tipo: "Poste", id: p.dataValues.id, name: p.dataValues.name, image: p.dataValues.image });
    for (const e of eventos)
      if (e.dataValues.image && !diskSet.has(e.dataValues.image))
        broken.push({ tipo: "Evento", id: e.dataValues.id, name: `Evento #${e.dataValues.id}`, image: e.dataValues.image });
    for (const c of ciudades)
      if (c.dataValues.image && !diskSet.has(c.dataValues.image))
        broken.push({ tipo: "Ciudad", id: c.dataValues.id, name: c.dataValues.name, image: c.dataValues.image });
    for (const u of usuarios)
      if (u.dataValues.image && !diskSet.has(u.dataValues.image))
        broken.push({ tipo: "Usuario", id: u.dataValues.id, name: `${u.dataValues.name} ${u.dataValues.lastname}`, image: u.dataValues.image });
    for (const s of soluciones)
      if (s.dataValues.image && !diskSet.has(s.dataValues.image))
        broken.push({ tipo: "Solución", id: s.dataValues.id_evento, name: `Evento #${s.dataValues.id_evento}`, image: s.dataValues.image });

    res.status(200).json(broken);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function clearBrokenImageRefs(req: Request, res: Response) {
  try {
    const diskSet = new Set((await readDiskFiles()).map((f) => f.path));

    const [postes, eventos, ciudades, usuarios, soluciones] = await Promise.all([
      PosteModel.findAll({ attributes: ["id", "image"], paranoid: false }),
      EventoModel.findAll({ attributes: ["id", "image"], paranoid: false }),
      CiudadModel.findAll({ attributes: ["id", "image"], paranoid: false }),
      UsuarioModel.findAll({ attributes: ["id", "image"], paranoid: false }),
      SolucionModel.findAll({ attributes: ["id", "image"], paranoid: false }),
    ]);

    const isBroken = (img: string | null | undefined) => img && !diskSet.has(img);
    let cleared = 0;

    await Promise.all([
      ...postes.filter((r) => isBroken(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
      ...eventos.filter((r) => isBroken(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
      ...ciudades.filter((r) => isBroken(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
      ...usuarios.filter((r) => isBroken(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
      ...soluciones.filter((r) => isBroken(r.dataValues.image)).map((r) => { cleared++; return r.update({ image: null }); }),
    ]);

    res.status(200).json({ cleared });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteOrphanFiles(req: Request, res: Response) {
  try {
    const [files, dbMap] = await Promise.all([
      readDiskFiles(),
      getAllDbImageMap(),
    ]);
    const orphans = files.filter((f) => !dbMap.has(f.path));
    await Promise.all(orphans.map((f) => fs.promises.unlink(path.join(IMAGES_DIR, f.name))));
    res.status(200).json({ deleted: orphans.length, files: orphans.map((f) => f.name) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
