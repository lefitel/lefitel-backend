import sharp from "sharp";
import fs from "fs";

export async function UploadImage(req, res) {
  /*
  console.log(req.file);
  console.log(req.file.destination);
  console.log(req.file.filename);
  console.log(req.file.path);
  return res.status(200).json({ path: `images/${req.file.filename}` });
*/

  if (!req.file) {
    return res.status(500).send("No se ha enviado ninguna imagen");
  }

  // Ruta del archivo cargado temporalmente
  const inputImagePath = req.file.path;
  // Ruta de la imagen de salida comprimida
  const path = "/" + `${Date.now()}_${req.file.originalname}`;

  // Comprimir la imagen
  sharp(req.file.buffer)
    .resize({ height: 1000 })
    .jpeg({ quality: 60 })
    .toFile(`/images${path}`, (err, info) => {
      if (err) {
        return res.status(500).send("Error al comprimir la imagen");
      } else {
        return res.status(200).json({ path });
      }
    });
}
