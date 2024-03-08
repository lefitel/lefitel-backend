import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";

export const TipoObsModel = sequelize.define("tipoObs", {
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
});
