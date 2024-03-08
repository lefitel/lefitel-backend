import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";

export const SolucionModel = sequelize.define("solucion", {
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
});

EventoModel.hasMany(SolucionModel, {
  foreignKey: "id_evento",
});
SolucionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
