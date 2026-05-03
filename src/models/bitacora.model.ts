import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { IBitacora } from "../interfaces/index.js";
type BitacoraCreation = Optional<IBitacora, "id">;
export const BitacoraModel: ModelDefined<IBitacora, BitacoraCreation> = sequelize.define("bitacora", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  detail: {
    type: DataTypes.STRING(500),
    allowNull: false,
  },
  entity: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  entity_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  id_usuario: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  severity: {
    type: DataTypes.ENUM('info', 'warning', 'critical'),
    allowNull: false,
    defaultValue: 'info',
  },
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: true,
  },
});

UsuarioModel.hasMany(BitacoraModel, {
  foreignKey: "id_usuario",
});
BitacoraModel.belongsTo(UsuarioModel, {
  foreignKey: "id_usuario",
});
