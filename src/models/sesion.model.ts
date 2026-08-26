import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ISesion } from "../interfaces/index.js";

// `revoked_at`, `user_agent`, `ip_address`, `mfa_satisfied_at` and
// `mfa_source` are optional here even though `ISesion` requires them, so that
// `createSession` (a later task) can create a row without naming all five —
// they still resolve to `null` on both sides, since the columns below allow
// it. `estado` is optional too, but for the opposite reason: it has a
// default value below rather than allowing null.
type SesionCreation = Optional<
  ISesion,
  "revoked_at" | "user_agent" | "ip_address" | "estado" | "mfa_satisfied_at" | "mfa_source"
>;

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
    // A default here, not only in application code, so a bulkInsert, a seed
    // script or a rescue script that skips `id` fails on nothing — the column
    // itself is NOT NULL with no default in the migration, since a migration
    // should not need to know how the application generates its keys.
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: DataTypes.UUIDV4 },
    id_usuario: { type: DataTypes.INTEGER, allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    ip_address: { type: DataTypes.STRING(45), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    last_used_at: { type: DataTypes.DATE, allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    // Mirrors the migration's DB-level default so a `.create(...)` that
    // omits `estado` does not fail Sequelize's own `notNull` validation
    // before ever reaching Postgres.
    estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "completa" },
    // Written only by a live proof of a factor — null on a session opened
    // via a remembered device, on purpose.
    mfa_satisfied_at: { type: DataTypes.DATE, allowNull: true },
    mfa_source: { type: DataTypes.STRING(20), allowNull: true },
  },
  { tableName: "sesiones", timestamps: false },
);

UsuarioModel.hasMany(SesionModel, { foreignKey: "id_usuario" });
SesionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
