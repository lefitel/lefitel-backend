import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IAdss } from "../interfaces/index.js";
type AdssCreation = Optional<IAdss, "id">;
export const AdssModel: ModelDefined<IAdss, AdssCreation> = sequelize.define("adss", {
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
}, { paranoid: true });
