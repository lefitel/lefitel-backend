import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { IDispositivoRecordado } from "../interfaces/index.js";

type Creation = Optional<IDispositivoRecordado, "id" | "revoked_at">;

/**
 * One browser that has already proved a factor and asked not to be asked again.
 *
 * `id_usuario` is not bookkeeping: the acceptance condition is
 * `token_hash = ? AND id_usuario = ? AND revoked_at IS NULL AND expires_at > now()`,
 * all four together. Checked on the hash alone, ticking "remember me" on your
 * own account and carrying that cookie to somebody else's login would skip
 * *their* second factor.
 */
export const DispositivoRecordadoModel: ModelDefined<IDispositivoRecordado, Creation> =
  sequelize.define(
    "dispositivo_recordado",
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: DataTypes.UUIDV4 },
      id_usuario: { type: DataTypes.INTEGER, allowNull: false },
      token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      user_agent: { type: DataTypes.STRING(255), allowNull: true },
      ip_address: { type: DataTypes.STRING(45), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      // Both explicit, both load-bearing. The name because Sequelize would
      // pluralise it into a table nothing creates; the timestamps because this
      // table has `created_at`, not `createdAt`, and leaving them on makes
      // every INSERT name two columns that do not exist.
      tableName: "dispositivo_recordado",
      timestamps: false,
      // Hallazgo B10, confirmed by running `toJSON`: with neither a
      // `defaultScope` nor a `toJSON` override, a query that reaches this row
      // — including via `usuarios.hasMany(...)` below through some future
      // controller's `include` — serialises the hashed cookie value straight
      // out. `defaultScope` stops a bare read; an explicit `include` that
      // lists its own `attributes` bypasses a scope, which is why `toJSON`
      // below exists too — independent, not redundant.
      defaultScope: {
        attributes: { exclude: ["token_hash"] },
      },
    },
  );

// See the comment on `credencialWebauthn.model.ts`'s equivalent block: the
// prototype is where a per-model `toJSON` lives under the `.define()` API,
// and the cast sidesteps `Model#toJSON`'s overloads rather than fighting them.
(DispositivoRecordadoModel.prototype as unknown as Record<string, unknown>).toJSON = function (
  this: { get(): Record<string, unknown> },
) {
  const valores = { ...this.get() };
  delete valores.token_hash;
  return valores;
};

UsuarioModel.hasMany(DispositivoRecordadoModel, { foreignKey: "id_usuario" });
DispositivoRecordadoModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
