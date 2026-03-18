import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { ICiudad } from "../interfaces/index.js";
type CiudadCreation = Optional<ICiudad, "id">;
export const CiudadModel: ModelDefined<ICiudad, CiudadCreation> = sequelize.define("ciudad", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  image: {
    type: DataTypes.STRING,
  },
  lat: {
    allowNull: false,
    type: DataTypes.DOUBLE,
  },
  lng: {
    allowNull: false,
    type: DataTypes.DOUBLE,
  },
}, { paranoid: true });
