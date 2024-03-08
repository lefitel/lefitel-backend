import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { AdssModel } from "./adss.model.js";
import { PosteModel } from "./poste.model.js";

export const AdssPosteModel = sequelize.define("adssposte", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  id_adss: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_poste: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});
AdssModel.hasMany(AdssPosteModel, { foreignKey: "id_adss" });
AdssPosteModel.belongsTo(AdssModel, { foreignKey: "id_adss" });

PosteModel.hasMany(AdssPosteModel, { foreignKey: "id_poste" });
AdssPosteModel.belongsTo(PosteModel, { foreignKey: "id_poste" });
/*
//Relacion con evento

*/
