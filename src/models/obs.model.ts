import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { TipoObsModel } from "./tipoObs.model.js";
import { IObs } from "../interfaces/index.js";
type ObsCreation = Optional<IObs, "id">;
export const ObsModel: ModelDefined<IObs, ObsCreation> = sequelize.define("obs", {
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
  id_tipoObs: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, { paranoid: true });

TipoObsModel.hasMany(ObsModel, {
  foreignKey: "id_tipoObs",
});
ObsModel.belongsTo(TipoObsModel, {
  foreignKey: "id_tipoObs",
  as: "tipoObs",
});
