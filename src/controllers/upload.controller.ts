import { Request, Response } from "express";
import sharp from "sharp";
import fs from "fs";
import { logAction } from "../utils/logAction.js";

const IMAGES_DIR = process.env.IMAGES_DIR ?? "/images";

export async function UploadImage(req: Request, res: Response) {
  if (!req.file) {
    return res.status(500).send("No se ha enviado ninguna imagen");
  }

  // Crear directorio si no existe (útil en desarrollo local)
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const baseName = req.file.originalname.replace(/\.[^/.]+$/, "");
  const path = "/" + `${Date.now()}_${baseName}.webp`;

  sharp(req.file.buffer)
    .resize({ height: 1920, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(`${IMAGES_DIR}${path}`, (err, _info) => {
      if (err) {
        return res.status(500).send("Error al comprimir la imagen");
      } else {
        logAction({ id_usuario: req.user?.id, action: "UPLOAD_IMAGE", entity: "File", entity_id: null, detail: `Subió imagen ${path}`, metadata: { after: { path } }, severity: 'info' });
        return res.status(200).json({ path });
      }
    });
}
