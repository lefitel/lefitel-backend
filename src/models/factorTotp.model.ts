import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { IFactorTotp } from "../interfaces/index.js";

// `id` is optional for the usual autoincrement reason. `key_version` is
// optional because the model mirrors the migration's DB-level default of 1
// below. `ultimo_paso` and `confirmed_at` are optional because both are
// logically absent the moment a secret is generated: there is no accepted
// time step yet, and the factor is unconfirmed until the person types a code
// back — an unconfirmed factor must not satisfy anything.
type FactorTotpCreation = Optional<IFactorTotp, "id" | "key_version" | "ultimo_paso" | "confirmed_at">;

/**
 * One account's TOTP secret. `id_usuario` is unique: one factor per account,
 * never two secrets that both open the door.
 *
 * `tableName` and `timestamps: false` are both deliberate, same reasoning as
 * every other model in this schema: Sequelize's own pluralisation has already
 * produced `ciudads`, `rols` and `revicions` here, and this table keeps its
 * own `created_at` rather than Sequelize's `createdAt`/`updatedAt` pair.
 */
export const FactorTotpModel: ModelDefined<IFactorTotp, FactorTotpCreation> = sequelize.define(
  "factor_totp",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    secreto_cifrado: { type: DataTypes.BLOB, allowNull: false },
    // Both NOT NULL, and both useless as an afterthought: AES-256-GCM cannot
    // decrypt without the nonce, and cannot be trusted without the tag.
    iv: { type: DataTypes.BLOB, allowNull: false },
    auth_tag: { type: DataTypes.BLOB, allowNull: false },
    // Declared here too, not only as the migration's DB-level DEFAULT:
    // Sequelize's own `allowNull: false` validation runs before a query ever
    // reaches Postgres, so a `.create(...)` that omits `key_version` would
    // fail client-side on a notNull violation without this.
    key_version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    // Anti-replay: the last accepted time step. A code stays valid for its
    // whole window, so without this the same six digits work twice.
    ultimo_paso: { type: DataTypes.BIGINT, allowNull: true },
    confirmed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  {
    tableName: "factor_totp",
    timestamps: false,
  },
);

UsuarioModel.hasMany(FactorTotpModel, { foreignKey: "id_usuario" });
FactorTotpModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
