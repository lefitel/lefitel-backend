import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { ISolucion } from "../interfaces/index.js";
type SolucionCreation = Optional<ISolucion, "id">;
export const SolucionModel: ModelDefined<ISolucion, SolucionCreation> = sequelize.define("solucion", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  description: {
    type: DataTypes.STRING,
  },
  image: {
    type: DataTypes.STRING,
  },
  date: {
    type: DataTypes.DATE,
  },
  id_evento: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // Who carried out the repair. Nullable, same reasoning as revision.
  id_usuario: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, { paranoid: true });

/** What a REST response may carry. See REVISION_PUBLIC_ATTRIBUTES. */
export const SOLUCION_PUBLIC_ATTRIBUTES = [
  "id", "description", "image", "date", "id_evento",
] as const;

EventoModel.hasMany(SolucionModel, {
  foreignKey: "id_evento",
  onDelete: "CASCADE",
});
SolucionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
UsuarioModel.hasMany(SolucionModel, {
  foreignKey: "id_usuario",
});
SolucionModel.belongsTo(UsuarioModel, {
  foreignKey: "id_usuario",
});
