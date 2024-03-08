import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";

export const RevicionModel = sequelize.define("revicion", {
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
});

EventoModel.hasMany(RevicionModel, {
  foreignKey: "id_evento",
});
RevicionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
