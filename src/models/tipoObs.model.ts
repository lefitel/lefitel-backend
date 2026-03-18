import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { ITipoObs } from "../interfaces/index.js";
type TipoObsCreation = Optional<ITipoObs, "id">;
export const TipoObsModel: ModelDefined<ITipoObs, TipoObsCreation> = sequelize.define("tipoObs", {
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
}, { paranoid: true });
