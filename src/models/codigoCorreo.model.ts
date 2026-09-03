import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ICodigoCorreo } from "../interfaces/index.js";

// `id` is optional for the usual autoincrement reason; `used_at` because a
// freshly minted code has not been spent; `intentos` because the column has a
// real `DEFAULT 0` and a fresh code has had none. `created_at` is NOT optional
// even though the column has `DEFAULT now()`: `emailCodeStore.ts` writes the
// clock it also uses for the cooldown and the caps, so the row and the count
// agree on what "now" was.
type CodigoCorreoCreation = Optional<ICodigoCorreo, "id" | "used_at" | "intentos">;

/**
 * One login code sent by email.
 *
 * `codigo_hash` is bcrypt — six digits and a fast hash would be an offline
 * break in milliseconds from a dump taken inside the ten-minute window.
 * `intentos` is charged before the compare, by the statement that reads the
 * hash; see `auth/emailCodeStore.ts`.
 *
 * `tableName` and `timestamps: false` are both deliberate, same reasoning as
 * every other model in this schema: Sequelize's own pluralisation has already
 * produced `ciudads`, `rols` and `revicions` here, and this table keeps its
 * own `created_at` rather than Sequelize's `createdAt`/`updatedAt` pair.
 */
export const CodigoCorreoModel: ModelDefined<ICodigoCorreo, CodigoCorreoCreation> = sequelize.define(
  "codigo_correo",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: false },
    email_destino: { type: DataTypes.STRING(255), allowNull: false },
    codigo_hash: { type: DataTypes.STRING(60), allowNull: false },
    intentos: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  {
    tableName: "codigo_correo",
    timestamps: false,
    // Hallazgo B10, same as `codigoRecuperacion.model.ts`: with neither a
    // `defaultScope` nor a `toJSON` override, a query that reaches this row
    // serialises `{"codigo_hash":"$2b$12$..."}`. `defaultScope` covers a bare
    // read and an `include` that lists no `attributes` of its own; `toJSON`
    // below covers a row handed to `res.json` directly. **What neither
    // covers, said plainly**: a row nested inside a `usuario` instance that a
    // controller serialises — Sequelize builds nested output through
    // `get({ plain: true })`, not through the child's `toJSON` — when that
    // include also spells out `attributes` including the hash. No code does
    // that today, and no controller imports this model; the store reads the
    // hash itself and hands nothing to a response.
    defaultScope: {
      attributes: { exclude: ["codigo_hash"] },
    },
  },
);

// See the comment on `credencialWebauthn.model.ts`'s equivalent block: the
// prototype is where a per-model `toJSON` lives under the `.define()` API,
// and the cast sidesteps `Model#toJSON`'s overloads rather than fighting them.
(CodigoCorreoModel.prototype as unknown as Record<string, unknown>).toJSON = function (
  this: { get(): Record<string, unknown> },
) {
  const valores = { ...this.get() };
  delete valores.codigo_hash;
  return valores;
};

UsuarioModel.hasMany(CodigoCorreoModel, { foreignKey: "id_usuario" });
CodigoCorreoModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
