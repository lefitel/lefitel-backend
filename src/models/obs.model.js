import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { TipoObsModel } from "./tipoObs.model.js";

export const ObsModel = sequelize.define("obs", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  description: {
    type: DataTypes.STRING,
  },
  id_tipoObs: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});

TipoObsModel.hasMany(ObsModel, {
  foreignKey: "id_tipoObs",
});
ObsModel.belongsTo(TipoObsModel, {
  foreignKey: "id_tipoObs",
});
