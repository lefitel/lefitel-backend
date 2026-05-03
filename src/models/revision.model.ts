import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { EventoModel } from "./evento.model.js";
import { IRevision } from "../interfaces/index.js";
type RevisionCreation = Optional<IRevision, "id">;
export const RevisionModel: ModelDefined<IRevision, RevisionCreation> = sequelize.define("revision", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  description: {
    type: DataTypes.STRING,
  },
  date: {
    type: DataTypes.DATE,
  },
  id_evento: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, { tableName: "revicions", paranoid: true });

EventoModel.hasMany(RevisionModel, {
  foreignKey: "id_evento",
  onDelete: "CASCADE",
});
RevisionModel.belongsTo(EventoModel, {
  foreignKey: "id_evento",
});
