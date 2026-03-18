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

function readDiskFiles(): FileInfo[] {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR).map((name) => {
    const stats = fs.statSync(path.join(IMAGES_DIR, name));
    return { name, path: `/${name}`, size: stats.size, createdAt: stats.birthtime };
  });
}

export async function getFiles(req: Request, res: Response) {
  try {
    const files = readDiskFiles();
    res.status(200).json(files);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getOrphanFiles(req: Request, res: Response) {
  try {
    const [files, dbMap] = await Promise.all([
      Promise.resolve(readDiskFiles()),
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

export async function deleteOrphanFiles(req: Request, res: Response) {
  try {
    const [files, dbMap] = await Promise.all([
      Promise.resolve(readDiskFiles()),
      getAllDbImageMap(),
    ]);
    const orphans = files.filter((f) => !dbMap.has(f.path));
    orphans.forEach((f) => fs.unlinkSync(path.join(IMAGES_DIR, f.name)));
    res.status(200).json({ deleted: orphans.length, files: orphans.map((f) => f.name) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
