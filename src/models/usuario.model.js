import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { RolModel } from "./rol.model.js";

export const UsuarioModel = sequelize.define("usuario", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  lastname: {
    type: DataTypes.STRING,
  },
  birthday: {
    type: DataTypes.DATE,
  },
  image: {
    type: DataTypes.STRING,
  },
  phone: {
    type: DataTypes.STRING,
  },
  user: {
    type: DataTypes.STRING,
  },
  pass: {
    type: DataTypes.STRING,
  },
  id_rol: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});

RolModel.hasMany(UsuarioModel, {
  foreignKey: "id_rol",
});
UsuarioModel.belongsTo(RolModel, {
  foreignKey: "id_rol",
});
