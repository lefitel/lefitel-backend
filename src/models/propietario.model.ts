import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IPropietario } from "../interfaces/index.js";
type PropietarioCreation = Optional<IPropietario, "id">;
export const PropietarioModel: ModelDefined<IPropietario, PropietarioCreation> = sequelize.define("propietario", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
}, { paranoid: true });
