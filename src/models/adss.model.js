import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";

export const AdssModel = sequelize.define("adss", {
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
