import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
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
}, { paranoid: true });

EventoModel.hasMany(SolucionModel, {
  foreignKey: "id_evento",
  onDelete: "CASCADE",
});
SolucionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
