import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { IRevision } from "../interfaces/index.js";
type RevisionCreation = Optional<IRevision, "id">;
export const RevisionModel: ModelDefined<IRevision, RevisionCreation> = sequelize.define("revision", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  description: {
    type: DataTypes.STRING,
  },
  date: {
    type: DataTypes.DATE,
  },
  id_evento: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // Who did the inspection. Nullable because most of the history predates the
  // audit log it was recovered from — see the authorship migration.
  id_usuario: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, { tableName: "revicions", paranoid: true });

/**
 * What a REST response may carry — `id_usuario` deliberately absent.
 *
 * The catalog puts the author behind `seguridad.ver` (catalog.ts, the `usuario`
 * relation), and a finder with no `attributes` at all undoes that in one line:
 * the moment the column joined the model, `GET /revision/:id_evento` started
 * shipping it to every authenticated account, the Cliente role included, and
 * `GET /evento` already returns `usuario {id, name, lastname}` to join it
 * against. The generator is where authorship is exposed, gated; here it is not.
 *
 * Named rather than inlined at each of the call sites because there are several
 * and the failure is silent: adding a column is what causes it, and this list
 * sits where somebody adding one will be looking.
 */
export const REVISION_PUBLIC_ATTRIBUTES = ["id", "description", "date", "id_evento"] as const;

EventoModel.hasMany(RevisionModel, {
  foreignKey: "id_evento",
  onDelete: "CASCADE",
});
RevisionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
// No onDelete here: the constraint is the migration's, and it is SET NULL. An
// account leaving must not take the inspections it recorded with it.
UsuarioModel.hasMany(RevisionModel, {
  foreignKey: "id_usuario",
});
RevisionModel.belongsTo(UsuarioModel, {
  foreignKey: "id_usuario",
});
