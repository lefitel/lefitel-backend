import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
import { IRevicion } from "../interfaces/index.js";
type RevicionCreation = Optional<IRevicion, "id">;
export const RevicionModel: ModelDefined<IRevicion, RevicionCreation> = sequelize.define("revicion", {
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
}, { paranoid: true });

EventoModel.hasMany(RevicionModel, {
  foreignKey: "id_evento",
  onDelete: "CASCADE",
});
RevicionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
