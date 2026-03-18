import { Request, Response } from "express";
import sharp from "sharp";
import fs from "fs";

const IMAGES_DIR = process.env.IMAGES_DIR ?? "/images";

export async function UploadImage(req: Request, res: Response) {
  if (!req.file) {
    return res.status(500).send("No se ha enviado ninguna imagen");
  }

  // Crear directorio si no existe (útil en desarrollo local)
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const path = "/" + `${Date.now()}_${req.file.originalname}`;

  sharp(req.file.buffer)
    .resize({ height: 1000 })
    .jpeg({ quality: 60 })
    .toFile(`${IMAGES_DIR}${path}`, (err, _info) => {
      if (err) {
        return res.status(500).send("Error al comprimir la imagen");
      } else {
        return res.status(200).json({ path });
      }
    });
}
