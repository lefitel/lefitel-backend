import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";

export const MaterialModel = sequelize.define("material", {
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
