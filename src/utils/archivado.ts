import type { Model, ModelStatic, WhereOptions } from "sequelize";

/**
 * Archive and unarchive, saying whether there was anything to act on.
 *
 * Seventeen handlers ran `destroy({ where: { id } })` or `restore(...)` and then
 * wrote "Archivó … #id" to the audit log without looking at the result. Neither
 * call fails when nothing matches, so `DELETE /tipoObs/99999` answered 204 and
 * left a `critical` line saying a record had been archived — a record that
 * never existed. The same for archiving twice, and for restoring something that
 * was not archived. The log is read to find out what happened; a line for
 * something that did not happen is worse than a missing one.
 *
 * Both return `false` when no row changed, and the caller answers 404 and
 * writes nothing.
 */
export async function archivar<M extends Model>(modelo: ModelStatic<M>, id: unknown): Promise<boolean> {
  // On a paranoid model this only matches rows that are not archived yet, so an
  // already-archived row counts zero as well.
  const afectadas = await modelo.destroy({ where: { id } as WhereOptions });
  return afectadas > 0;
}

export async function desarchivar<M extends Model>(modelo: ModelStatic<M>, id: unknown): Promise<boolean> {
  // `restore` resolves to nothing, so there is no count to read: the row is
  // looked for first, among the archived ones only.
  const fila = await modelo.findOne({ where: { id } as WhereOptions, paranoid: false, attributes: ["id", "deletedAt"] });
  if (!fila || fila.get("deletedAt") == null) return false;
  await modelo.restore({ where: { id } as WhereOptions });
  return true;
}

export const NADA_QUE_ARCHIVAR = "El registro no existe o ya estaba archivado.";
export const NADA_QUE_DESARCHIVAR = "El registro no existe o no estaba archivado.";
