import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
import { ObsModel } from "./obs.model.js";

export const EventoObsModel = sequelize.define("eventoObs", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  id_evento: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_obs: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});

ObsModel.hasMany(EventoObsModel, {
  foreignKey: "id_obs",
});
EventoObsModel.belongsTo(ObsModel, {
  foreignKey: "id_obs",
});

EventoModel.hasMany(EventoObsModel, {
  foreignKey: "id_evento",
});
EventoObsModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
