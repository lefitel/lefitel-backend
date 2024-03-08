import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";

import { PosteModel } from "./poste.model.js";

export const EventoModel = sequelize.define("evento", {
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
  state: {
    type: DataTypes.BOOLEAN,
  },
  id_poste: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});
PosteModel.hasMany(EventoModel, {
  foreignKey: "id_poste",
});
EventoModel.belongsTo(PosteModel, {
  foreignKey: "id_poste",
});
