import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ISesion } from "../interfaces/index.js";

type SesionCreation = Optional<ISesion, "revoked_at" | "user_agent" | "ip_address">;

/**
 * `tableName` and `timestamps: false` are both deliberate.
 *
 * The name because Sequelize's pluralisation is not trusted in this schema. The
 * timestamps because this table keeps its own three dates with meanings
 * Sequelize's pair does not have: `last_used_at` is not `updatedAt` (it is
 * throttled), and `expires_at` is not derived from anything.
 */
export const SesionModel: ModelDefined<ISesion, SesionCreation> = sequelize.define(
  "sesion",
  {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    ip_address: { type: DataTypes.STRING(45), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    last_used_at: { type: DataTypes.DATE, allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "sesiones", timestamps: false },
);

UsuarioModel.hasMany(SesionModel, { foreignKey: "id_usuario" });
SesionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
