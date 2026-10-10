import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { IBitacora } from "../interfaces/index.js";
import type { BitacoraAction, BitacoraEntity } from "../utils/bitacoraVocabulary.js";
// What may be *written* is narrower than what may be read. A row read back can
// carry a code nothing writes any more, so `IBitacora` keeps `string`; a row
// created must name an action and an entity the vocabulary declares. Typing
// only `logAction` left this model open to anyone calling `create` directly —
// which `rescueCore` does, on purpose.
type BitacoraCreation = Optional<
  Omit<IBitacora, "action" | "entity"> & { action: BitacoraAction; entity: BitacoraEntity },
  "id"
>;
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
