import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ICredencialWebauthn } from "../interfaces/index.js";

// `id` is optional here for the usual autoincrement reason. `counter` is
// optional because the model mirrors the migration's own DB-level default of
// 0 below, and `transports` / `last_used_at` are optional because neither is
// known at the moment a passkey is registered: `transports` depends on what
// the browser reports (not every one does), and `last_used_at` is null until
// the credential is used for the first time.
type CredencialWebauthnCreation = Optional<
  ICredencialWebauthn,
  "id" | "counter" | "transports" | "last_used_at"
>;

/**
 * One registered passkey / security key. Verified against `credential_id`
 * alone — the assertion that comes back at login names only that, with no
 * user to scope the lookup by — which is why `credential_id` is unique across
 * the whole table rather than per user.
 *
 * `tableName` and `timestamps: false` are both deliberate, same reasoning as
 * every other model in this schema: Sequelize's own pluralisation has already
 * produced `ciudads`, `rols` and `revicions` here, and this table keeps its
 * own `created_at` rather than Sequelize's `createdAt`/`updatedAt` pair.
 */
export const CredencialWebauthnModel: ModelDefined<ICredencialWebauthn, CredencialWebauthnCreation> =
  sequelize.define(
    "credencial_webauthn",
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_usuario: { type: DataTypes.INTEGER, allowNull: false },
      credential_id: { type: DataTypes.TEXT, allowNull: false, unique: true },
      public_key: { type: DataTypes.BLOB, allowNull: false },
      // Declared here too, not only as the migration's DB-level DEFAULT:
      // Sequelize's own `allowNull: false` validation runs before a query
      // ever reaches Postgres, so a `.create(...)` that omits `counter`
      // would fail client-side on a notNull violation without this.
      counter: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      transports: { type: DataTypes.STRING(255), allowNull: true },
      nombre: { type: DataTypes.STRING(100), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      last_used_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "credencial_webauthn",
      timestamps: false,
    },
  );

UsuarioModel.hasMany(CredencialWebauthnModel, { foreignKey: "id_usuario" });
CredencialWebauthnModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
