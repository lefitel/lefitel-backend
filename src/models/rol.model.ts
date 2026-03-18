import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IRol } from "../interfaces/index.js";
type RolCreation = Optional<IRol, "id">;
export const RolModel: ModelDefined<IRol, RolCreation> = sequelize.define("rol", {
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
