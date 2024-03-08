import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";

export const BitacoraModel = sequelize.define("bitacora", {
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
  id_usuario: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});

UsuarioModel.hasMany(BitacoraModel, {
  foreignKey: "id_usuario",
});
BitacoraModel.belongsTo(UsuarioModel, {
  foreignKey: "id_usuario",
});
