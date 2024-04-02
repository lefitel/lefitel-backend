import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
//import { PosteModel } from "./poste.model.js";

export const CiudadModel = sequelize.define("ciudad", {
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
});
