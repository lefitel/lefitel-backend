import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";

import { PosteModel } from "./poste.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { IEvento } from "../interfaces/index.js";
type EventoCreation = Optional<IEvento, "id">;
export const EventoModel: ModelDefined<IEvento, EventoCreation> = sequelize.define("evento", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  description: {
    type: DataTypes.STRING,
  },
  image: {
    type: DataTypes.STRING,
  },
  date: {
    type: DataTypes.DATE,
  },
  state: {
    type: DataTypes.BOOLEAN,
  },
  priority: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  id_poste: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_usuario: {
    type: DataTypes.INTEGER,
  },
}, { paranoid: true });
PosteModel.hasMany(EventoModel, {
  foreignKey: "id_poste",
});
EventoModel.belongsTo(PosteModel, {
  foreignKey: "id_poste",
});
UsuarioModel.hasMany(EventoModel, {
  foreignKey: "id_usuario",
});
EventoModel.belongsTo(UsuarioModel, {
  foreignKey: "id_usuario",
});
