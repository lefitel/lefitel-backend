import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";

export const RolModel = sequelize.define("rol", {
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
