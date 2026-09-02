import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ICodigoRecuperacion } from "../interfaces/index.js";

// `id` is optional for the usual autoincrement reason. `used_at` is optional
// because it is logically absent at creation — a freshly issued code has not
// been redeemed yet — the same reasoning `token_uso_unico.model.ts` applies
// to its own `used_at`. `prefijo` is NOT optional: it is derived from the
// code at the exact moment the code is generated, the same instant as
// `codigo_hash`, so there is no creation path that has one without the other.
type CodigoRecuperacionCreation = Optional<ICodigoRecuperacion, "id" | "used_at">;

/**
 * One outstanding recovery code.
 *
 * `codigo_hash` is bcrypt, not SHA-256 — the opposite choice from
 * `sesiones.token_hash`, and deliberate: a recovery code is short enough to
 * be written on paper, so a fast hash plus a stolen database dump is an
 * offline break in hours.
 *
 * `prefijo` exists so verifying a code costs one `bcryptjs.compare`, not ten
 * — see `20260902000001-recovery-code-prefix.ts` for the measurement (2646ms,
 * 88% event-loop starvation) that makes this a DoS fix, not an optimisation.
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
      // The first 8 characters of the code, in clear, matching the migration's
      // `CHAR(8)` exactly — a value shorter or longer than what this arc's
      // codes produce fails at the column instead of being silently padded
      // or truncated. See `ICodigoRecuperacion.prefijo` in
      // `interfaces/index.ts` for why storing it unhashed does not weaken
      // anything, and what it costs not to have it.
      prefijo: { type: DataTypes.CHAR(8), allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    },
    {
      tableName: "codigo_recuperacion",
      timestamps: false,
      // Hallazgo B10, confirmed by running `toJSON`: with neither a
      // `defaultScope` nor a `toJSON` override, a query that reaches this row
      // — including via `usuarios.hasMany(...)` below through some future
      // controller's `include` — serialises `{"codigo_hash":"$2b$12$..."}`.
      // `defaultScope` stops a bare read; an explicit `include` that lists
      // its own `attributes` bypasses a scope, which is why `toJSON` below
      // exists too — independent, not redundant. `prefijo` is deliberately
      // NOT excluded here: see its own comment above — it is plaintext by
      // design and leaking it costs an attacker nothing `codigo_hash` was not
      // already protecting.
      defaultScope: {
        attributes: { exclude: ["codigo_hash"] },
      },
    },
  );

// See the comment on `credencialWebauthn.model.ts`'s equivalent block: the
// prototype is where a per-model `toJSON` lives under the `.define()` API,
// and the cast sidesteps `Model#toJSON`'s overloads rather than fighting them.
(CodigoRecuperacionModel.prototype as unknown as Record<string, unknown>).toJSON = function (
  this: { get(): Record<string, unknown> },
) {
  const valores = { ...this.get() };
  delete valores.codigo_hash;
  return valores;
};

UsuarioModel.hasMany(CodigoRecuperacionModel, { foreignKey: "id_usuario" });
CodigoRecuperacionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
