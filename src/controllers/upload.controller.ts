import { Request, Response } from "express";
import sharp from "sharp";
import fs from "fs";
import { logAction } from "../utils/logAction.js";
import { resolveImagePath } from "../utils/fileUtils.js";
import { log } from "../utils/logger.js";

const uploadLog = log("upload");

const IMAGES_DIR = process.env.IMAGES_DIR ?? "/images";

/**
 * How a stored photograph comes out. The one compression in the whole chain:
 * the browser only shrinks what is over 8 MB, and gently (`Upload.api.ts`).
 *
 * Field photographs get zoomed into — a plate, a label, a crack — so detail is
 * the point. Until May 2026 this was 1000 px tall at JPEG 60, and that is why
 * three in four photographs on the system look blurry (measured on the
 * production copy of 14 October 2026; those cannot be recovered, the originals
 * were never kept). Then 1920 px of *height* at webp 80, which left a portrait
 * shot at 1440 px wide. Now the longest side, either way round, at webp 85: a
 * phone photo lands around 400-900 KB.
 */
export const COMPRESION = { ladoMaximo: 2560, calidad: 85 } as const;

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
      // First, and it matters: phones store many photos sideways with an EXIF
      // note saying how to turn them, and the webp below keeps no EXIF. Without
      // this the note is lost and the photograph lies on its side.
      .rotate()
      .resize({
        width: COMPRESION.ladoMaximo,
        height: COMPRESION.ladoMaximo,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: COMPRESION.calidad })
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
  return res.status(201).json({ path });
}
