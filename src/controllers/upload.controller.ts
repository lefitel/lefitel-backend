import { Request, Response } from "express";
import sharp from "sharp";
import fs from "fs";
import { logAction } from "../utils/logAction.js";
import { resolveImagePath } from "../utils/fileUtils.js";
import { log } from "../utils/logger.js";

const uploadLog = log("upload");

const IMAGES_DIR = process.env.IMAGES_DIR ?? "/images";

/**
 * A file name of our making, from a name we were handed.
 *
 * The uploaded name went into the destination by string concatenation, so
 * `../../../tmp/pwn.png` wrote outside the images directory — on Windows it
 * resolved to `C:\tmp\pwn.webp`, on the container to `/tmp`. Any account with
 * a session could do it: the route carries authentication and nothing else.
 * Reading was hardened months ago (`resolveImagePath`, after `%2F` in a route
 * parameter let an administrator delete any file on the box) and the writer was
 * left as it was.
 *
 * The name is not repaired, it is replaced: everything outside a small
 * allowlist is dropped, the timestamp guarantees uniqueness, and
 * `resolveImagePath` has the final word on where the result may live.
 */
export function safeName(originalName: unknown): string {
  const raw = typeof originalName === "string" ? originalName : "";
  const base = raw
    .replace(/\.[^/.]+$/, "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 _-]+/g, "")
    .trim()
    .slice(0, 60)
    .replace(/\s+/g, "_");
  return `${Date.now()}_${base || "imagen"}.webp`;
}

/**
 * Whose fault the upload was, said in the status code.
 *
 * Every failure here used to answer 500, including the four a caller causes: no
 * file, a file over the limit, the wrong field name, and something that is not
 * an image at all. Two things went wrong with that. The person at the other end
 * got "no se pudo subir la imagen" for a photograph that was simply too big, so
 * they retried the same file — there was nothing in the answer to tell them
 * otherwise. And a 500 is what gets alerted on, so four ordinary events sat in
 * the log looking like this server breaking, which is where a real one hides.
 *
 * The split below is the point: compressing is done in memory first, and only
 * then is anything written. A failure in the first step is a file we were handed
 * and cannot read — the caller's; a failure in the second is a disk that would
 * not take it — ours.
 */
export async function UploadImage(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ message: "No se envió ninguna imagen." });
  }

  const fileName = safeName(req.file.originalname);
  const destination = resolveImagePath(fileName, IMAGES_DIR);
  if (destination === null) {
    // Unreachable with a name this function built, and asserted rather than
    // assumed: the day `safeName` is edited, this is what stops the edit from
    // becoming a way out of the directory.
    return res.status(400).json({ message: "El nombre del archivo no es válido." });
  }
  const path = `/${fileName}`;

  let comprimida: Buffer;
  try {
    comprimida = await sharp(req.file.buffer)
      .resize({ height: 1920, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return res.status(400).json({ message: "El archivo no es una imagen que se pueda procesar." });
  }

  try {
    // Crear directorio si no existe (útil en desarrollo local)
    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
    await fs.promises.writeFile(destination, comprimida);
  } catch (err) {
    uploadLog.error({ err, path }, "no se pudo escribir la imagen en disco");
    return res.status(500).json({ message: "No se pudo guardar la imagen." });
  }

  logAction({ id_usuario: req.user?.id, action: "UPLOAD_IMAGE", entity: "File", entity_id: null, detail: `Subió imagen ${path}`, metadata: { after: { path } }, severity: 'info' });
  return res.status(200).json({ path });
}
