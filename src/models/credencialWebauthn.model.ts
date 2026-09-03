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
 * One registered passkey / security key.
 *
 * 🔴 **`credential_id` is unique across the whole table, and that is NOT an
 * invitation to look a credential up by it alone.** An earlier version of this
 * comment said exactly that — "the assertion that comes back at login names
 * only that, with no user to scope the lookup by" — and it is true only of the
 * passwordless ceremony of phase 2, where the credential *is* the identity.
 * In the second-factor path the session already says whose it is, and
 * `buscarCredencialDe` scopes by `(credential_id, id_usuario)` for a reason
 * written out there: looked up by id alone, a colleague who knows your
 * password finishes your login with *their own* fingerprint on a shared
 * machine. The uniqueness exists so that phase 2 can resolve an identity from
 * a credential; it says nothing about how phase 1 may query.
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
      // `STRING(1364)`, not `TEXT`, matching what `20260827000001` made of the
      // column: base64url of the 1023 bytes the WebAuthn specification allows.
      // TEXT under a unique btree accepts values the index cannot hold — past
      // ~2692 bytes of incompressible data Postgres refuses the INSERT with a
      // message about index row size that names nothing recognisable.
      credential_id: { type: DataTypes.STRING(1364), allowNull: false, unique: true },
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
      // `public_key` never has to leave the process: it is read here only to
      // verify an assertion, server-side, and a client never needs it back.
      // `defaultScope` keeps it out of a bare `findAll`/`findByPk`, but an
      // explicit `include: [{ model: CredencialWebauthnModel, attributes: [...] }]`
      // from another model's query overrides a scope's attribute list —
      // that is what `usuarios.hasMany(...)` below makes reachable from any
      // query that includes this table by name. `toJSON` further down is the
      // second, independent choke point: even a row read in full cannot leave
      // the process serialised with its key still on it.
      defaultScope: {
        attributes: { exclude: ["public_key"] },
      },
    },
  );

// Sequelize's `.define()` API has no `instanceMethods` option any more (that
// went away after v3), so the prototype is the only place left to hang a
// per-model `toJSON`. Cast through `unknown` rather than fighting
// `Model#toJSON`'s overloaded signature — the assignment is real at runtime
// regardless of the cast, and the cast is only there to give TypeScript an
// `unknown` target instead of an incompatible overload.
(CredencialWebauthnModel.prototype as unknown as Record<string, unknown>).toJSON = function (
  this: { get(): Record<string, unknown> },
) {
  const valores = { ...this.get() };
  delete valores.public_key;
  return valores;
};

UsuarioModel.hasMany(CredencialWebauthnModel, { foreignKey: "id_usuario" });
CredencialWebauthnModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
