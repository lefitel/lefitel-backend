import { UsuarioModel } from "../models/usuario.model.js";

export async function UploadImage(req, res) {
  console.log(req.file);
  console.log(req.file.destination);
  console.log(req.file.filename);
  console.log(req.file.path);
  return res.status(200).json({ path: `images/${req.file.filename}` });
}
