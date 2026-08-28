import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ISesion } from "../interfaces/index.js";

// `revoked_at`, `user_agent`, `ip_address`, `mfa_satisfied_at` and
// `mfa_source` are optional here even though `ISesion` requires them, so that
// `createSession` can create a row without naming all five — they still
// resolve to `null` on both sides, since the columns below allow it.
//
// **`estado` is deliberately not on that list.** It used to be, because the
// column had a `DEFAULT 'completa'` and the model mirrored it. That default
// was correct for exactly one statement — the `ALTER TABLE` that added the
// column to rows that predated states — and `20260827000001` has since
// removed it from the database. Leaving it here would keep the hole open from
// the other side: `estado` is what a session is allowed to do, and a creation
// that forgets it must not quietly come out with the run of the whole ERP.
//
// ⚠️ **What this line does not buy is a compiler check.** `tsconfig.json` sets
// `"strict": false`, which makes null and undefined assignable to everything
// and collapses Sequelize's `MakeNullishOptional` into "every field optional":
// `SesionModel.create({})`, with no fields at all, typechecks clean today.
// Measured, not assumed. So the type here is documentation plus the check this
// will become the day `strict` goes on — and it is `createSession`'s ordinary
// required parameter, which the compiler does enforce, that asks each call
// site the question.
//
// The two that actually refuse an omitted `estado` are Sequelize's notNull
// validation, which works only while the attribute below carries no
// `defaultValue`, and the column's own NOT NULL with nothing to fall back on.
// Both are pinned by tests in `factorModels.test.ts`.
type SesionCreation = Optional<
  ISesion,
  "revoked_at" | "user_agent" | "ip_address" | "mfa_satisfied_at" | "mfa_source"
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
    // No `defaultValue`, and that absence is the point — see the note on
    // `SesionCreation` above. A `.create(...)` that omits `estado` now fails
    // Sequelize's own `notNull` validation before any SQL is sent, which is
    // the answer that names the mistake instead of granting it.
    estado: { type: DataTypes.STRING(20), allowNull: false },
    // Written only by a live proof of a factor — null on a session opened
    // via a remembered device, on purpose.
    mfa_satisfied_at: { type: DataTypes.DATE, allowNull: true },
    mfa_source: { type: DataTypes.STRING(20), allowNull: true },
  },
  { tableName: "sesiones", timestamps: false },
);

UsuarioModel.hasMany(SesionModel, { foreignKey: "id_usuario" });
SesionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
