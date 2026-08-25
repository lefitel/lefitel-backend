import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ITokenUsoUnico } from "../interfaces/index.js";

// `id`, `used_at` and `created_at` are optional here even though
// `ITokenUsoUnico` requires them: `id` gets its default from the column
// below, `used_at` starts NULL on every row until it is redeemed, and
// `created_at` gets its default from the column too. `id_usuario`,
// `email_destino`, `token_hash`, `proposito` and `expires_at` stay required —
// there is no sensible default for any of them, and a row missing one is a
// token nobody can use safely.
type TokenUsoUnicoCreation = Optional<ITokenUsoUnico, "id" | "used_at" | "created_at">;

/**
 * `tableName` fixed explicitly, same reason as every other model in this
 * schema: Sequelize's own pluralisation has already produced `ciudads`,
 * `rols` and `revicions` here, and this name is the one the design spec
 * gives the table — not Sequelize's guess at pluralising it.
 *
 * `timestamps: false` because this table keeps its own `created_at`, and
 * Sequelize's automatic pair would either duplicate it under different names
 * or silently disagree about which column means "when this row was made".
 */
export const TokenUsoUnicoModel: ModelDefined<ITokenUsoUnico, TokenUsoUnicoCreation> =
  sequelize.define(
    "tokenUsoUnico",
    {
      // Default here and not only in application code, same reasoning as
      // `sesion.model.ts`'s `id`: a bulk insert or a rescue script that skips
      // `id` fails on nothing. The column itself has no default at the
      // migration level — a migration should not need to know how the
      // application generates its keys.
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: DataTypes.UUIDV4 },
      id_usuario: { type: DataTypes.INTEGER, allowNull: false },
      email_destino: { type: DataTypes.STRING(255), allowNull: false },
      // CHAR(64), not a looser VARCHAR: SHA-256 hex is always exactly 64
      // characters, and this is the same kind of value as `sesiones.token_hash`
      // for the same reason written there — a wider column buys nothing and
      // hides a bug that writes something else.
      token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      proposito: { type: DataTypes.STRING(32), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      // Declared here too, not only as a DB-level DEFAULT in the migration:
      // Sequelize's own `allowNull: false` validation runs before a query
      // ever reaches Postgres, so a `.create(...)` that omits `created_at`
      // would fail client-side on a "notNull Violation" without this,
      // whatever the column's real default says.
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: "token_uso_unico", timestamps: false },
  );

UsuarioModel.hasMany(TokenUsoUnicoModel, { foreignKey: "id_usuario" });
TokenUsoUnicoModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
