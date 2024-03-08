import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";

export const PropietarioModel = sequelize.define("propietario", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
});
