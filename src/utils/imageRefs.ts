// Whether a photograph is still somebody's, and deleting it only when it is not.
//
// Five controllers replace a photograph — a pole's, an event's, a city's, a
// user's portrait, and the repair photo an event loses when it is reopened —
// and each of them deleted the previous file on the way out. None of them
// checked that the previous value was a file that row had any claim to. The
// value comes from the row, but the row's value comes from a PUT: so a caller
// could set their own `image` to the name of any photograph in the system, and
// on their next edit the server would delete it as "the old one". The profile
// route is reachable by every account for its own row, and file names travel in
// responses that ask for no permission at all. Found by the audit of 3
// September.
//
// The rule now is the one the Archivos screen already applies when it looks for
// orphans: a file is in use while any row in any of the five tables names it —
// archived rows included, because an archived pole still has a photograph. Only
// a file nothing names may go. That closes the hole without needing to know who
// uploaded what, and it also fixes a smaller thing: reopening an event no longer
// deletes a repair photo that the soft-deleted `solucions` row still refers to.

import fs from "fs";
import { Op, WhereOptions } from "sequelize";
import { imageFileName, resolveImagePath } from "./fileUtils.js";
import { log } from "./logger.js";

const imagenesLog = log("imagenes");

/**
 * The ways one file name has been stored. `imageFileName` accepts more than
 * these on the way in; these are the shapes that exist in the data.
 */
export const spellingsOf = (name: string) => [name, `/${name}`, `images/${name}`, `/images/${name}`];

/**
 * The five tables that carry an `image` column, loaded when first asked and
 * not when this module is.
 *
 * Four controllers import this module, and their unit tests replace their own
 * model with a plain object (`vi.mock("../models/usuario.model.js", …)`). A
 * static import here of the *other* four models would run those modules at
 * load time, and each of them declares an association — `UsuarioModel.hasMany`,
 * `PosteModel.belongsTo` — against whatever `UsuarioModel` is at that moment.
 * Against the plain object, that throws, and the controller's whole test file
 * fails to load. The first version of this module did exactly that to
 * `usuario.controller.test.ts`. Loading the models on first use keeps a
 * controller importable with its model mocked, which is what every controller
 * test in this repository relies on.
 */
async function tablasConImagen(): Promise<ConImagen[]> {
  const [poste, evento, ciudad, usuario, solucion] = await Promise.all([
    import("../models/poste.model.js"),
    import("../models/evento.model.js"),
    import("../models/ciudad.model.js"),
    import("../models/usuario.model.js"),
    import("../models/solucion.model.js"),
  ]);
  // Five models over five attribute interfaces have no common Sequelize type;
  // what this module needs of each is one method, so that is the type.
  return [
    poste.PosteModel, evento.EventoModel, ciudad.CiudadModel, usuario.UsuarioModel, solucion.SolucionModel,
  ] as unknown as ConImagen[];
}

/** A table with an `image` column, as far as this module is concerned. */
type ConImagen = { count(opciones: { where: WhereOptions; paranoid: boolean }): Promise<number> };

/** Whether any row, archived or not, still names this file. */
export async function isImageReferenced(stored: unknown): Promise<boolean> {
  const name = imageFileName(stored);
  if (name === null) return false;
  const where = { image: { [Op.in]: spellingsOf(name) } };
  const tablas = await tablasConImagen();
  const counts = await Promise.all(tablas.map((t) => t.count({ where, paranoid: false })));
  return counts.some((c) => c > 0);
}

export type Borrado = "borrado" | "en uso" | "inválido" | "error";

/**
 * Deletes the file a stored value names, unless something still refers to it.
 *
 * Call it *after* the row that used to name the file has been saved with its
 * new value — otherwise that row still counts as a reference and the old
 * portrait is never cleaned up. Every failure is caught and logged here rather
 * than thrown: callers fire this without waiting, and an unhandled rejection
 * from a fire-and-forget promise takes the process down.
 */
export async function deleteImageIfUnreferenced(stored: unknown): Promise<Borrado> {
  try {
    const full = resolveImagePath(stored);
    if (full === null) return "inválido";
    if (await isImageReferenced(stored)) return "en uso";
    await fs.promises.unlink(full).catch(() => undefined);
    return "borrado";
  } catch (err) {
    imagenesLog.error({ err, imagen: stored }, "no se pudo decidir si borrar la imagen anterior");
    return "error";
  }
}
