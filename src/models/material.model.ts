import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IMaterial } from "../interfaces/index.js";
type MaterialCreation = Optional<IMaterial, "id">;
export const MaterialModel: ModelDefined<IMaterial, MaterialCreation> = sequelize.define("material", {
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
