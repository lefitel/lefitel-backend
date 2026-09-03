import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IRetoWebauthn } from "../interfaces/index.js";

// `id`, `used_at` and `created_at` are optional here even though
// `IRetoWebauthn` requires them: `id` gets its default from the column below,
// `used_at` starts NULL on every row until the challenge is spent, and
// `created_at` gets its default from the column too.
//
// `id_usuario` and `id_sesion` are **not** on this list, and the difference
// matters. They are optional in the interface itself — `number | null` — so a
// caller has to pass them explicitly even when the answer is null. Making them
// omissible would let the passwordless ceremony and a forgotten field look
// identical at the call site, and only one of those is meant to reach the
// database.
type RetoWebauthnCreation = Optional<IRetoWebauthn, "id" | "used_at" | "created_at">;

/**
 * `tableName` fixed explicitly, same reason as every other model in this
 * schema: Sequelize's own pluralisation has already produced `ciudads`,
 * `rols` and `revicions` here.
 *
 * `timestamps: false` because this table keeps its own `created_at`, and
 * Sequelize's automatic pair would either duplicate it under different names
 * or silently disagree about which column means "when this row was made".
 *
 * **No `defaultScope` hiding anything, unlike `credencial_webauthn`.** There
 * is nothing secret in a row here: the challenge itself is never stored, only
 * its SHA-256, and everything else is metadata about a ceremony that lasts two
 * minutes.
 */
export const RetoWebauthnModel: ModelDefined<IRetoWebauthn, RetoWebauthnCreation> = sequelize.define(
  "retoWebauthn",
  {
    // Default here and not only in the application code, same reasoning as
    // `sesion.model.ts`'s `id`: a bulk insert or a rescue script that skips
    // `id` fails on nothing. The column itself has no default at the migration
    // level — a migration should not need to know how the application
    // generates its keys.
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: DataTypes.UUIDV4 },
    // CHAR(64): SHA-256 hex is always exactly 64 characters, matching
    // `sesiones.token_hash` and `token_uso_unico.token_hash` for the same kind
    // of value and the same reason — a wider column buys nothing and hides a
    // bug that writes something else.
    reto_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    proposito: { type: DataTypes.STRING(32), allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: true },
    id_sesion: { type: DataTypes.UUID, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    // Declared here too, not only as a DB-level DEFAULT in the migration, so
    // a `.create(...)` that omits it gets a value from Sequelize rather than
    // relying on the column — the two agree, and neither is the only one.
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "reto_webauthn", timestamps: false },
);
