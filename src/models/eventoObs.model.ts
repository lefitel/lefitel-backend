import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
import { ObsModel } from "./obs.model.js";
import { IEventoObs } from "../interfaces/index.js";
type EventoObsCreation = Optional<IEventoObs, "id">;
export const EventoObsModel: ModelDefined<IEventoObs, EventoObsCreation> = sequelize.define("eventoObs", {
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
}, { paranoid: true });

ObsModel.hasMany(EventoObsModel, {
  foreignKey: "id_obs",
});
EventoObsModel.belongsTo(ObsModel, {
  foreignKey: "id_obs",
});

EventoModel.hasMany(EventoObsModel, {
  foreignKey: "id_evento",
  onDelete: "CASCADE",
});
EventoObsModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
