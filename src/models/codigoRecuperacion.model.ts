import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ICodigoRecuperacion } from "../interfaces/index.js";

// `id` is optional for the usual autoincrement reason. `used_at` is optional
// because it is logically absent at creation — a freshly issued code has not
// been redeemed yet — the same reasoning `token_uso_unico.model.ts` applies
// to its own `used_at`.
type CodigoRecuperacionCreation = Optional<ICodigoRecuperacion, "id" | "used_at">;

/**
 * One outstanding recovery code.
 *
 * `codigo_hash` is bcrypt, not SHA-256 — the opposite choice from
 * `sesiones.token_hash`, and deliberate: a recovery code is short enough to
 * be written on paper, so a fast hash plus a stolen database dump is an
 * offline break in hours.
 *
 * `tableName` and `timestamps: false` are both deliberate, same reasoning as
 * every other model in this schema: Sequelize's own pluralisation has already
 * produced `ciudads`, `rols` and `revicions` here, and this table keeps its
 * own `created_at` rather than Sequelize's `createdAt`/`updatedAt` pair.
 */
export const CodigoRecuperacionModel: ModelDefined<ICodigoRecuperacion, CodigoRecuperacionCreation> =
  sequelize.define(
    "codigo_recuperacion",
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_usuario: { type: DataTypes.INTEGER, allowNull: false },
      codigo_hash: { type: DataTypes.STRING(60), allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    },
    {
      tableName: "codigo_recuperacion",
      timestamps: false,
    },
  );

UsuarioModel.hasMany(CodigoRecuperacionModel, { foreignKey: "id_usuario" });
CodigoRecuperacionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
