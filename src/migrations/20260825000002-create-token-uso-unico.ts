import { QueryInterface, DataTypes } from "sequelize";

// One row per outstanding email-verification or password-reset link.
//
// `id_usuario` and `email_destino` are both NOT NULL, and that is the whole
// security property this table exists for: the redemption function
// (`consumirToken` in `src/auth/tokenStore.ts`) reads the owner and the
// address off the row the token names, never off anything a caller's request
// body says. Without an owner in the row, the redemption endpoint would have
// to take a user id from the body — and then a reset requested for one's own
// account could be redeemed against somebody else's.
//
// Table name set explicitly, same reason as `sesiones`: Sequelize's default
// pluralisation has already produced `ciudads`, `rols` and `revicions` in
// this schema, and `token_uso_unico` singular is the name the design spec
// gives it.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a
    // lock should make the migration fail fast and get retried, not queue
    // whatever else is touching `usuarios` behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      "token_uso_unico",
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
        },
        id_usuario: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          // RESTRICT, matching every other FK to `usuarios` added since
          // `20260804000001`: the 17 pre-existing FKs are CASCADE, and `rol`
          // being the only model without soft deletion has already been
          // measured taking 6 users and 4835 revisions with it through a
          // deleted role. Outstanding tokens are not joining that chain —
          // ending a user's pending tokens is code's job (see the email-change
          // path in a later task), and it stays explicit.
          onDelete: "RESTRICT",
        },
        email_destino: {
          // The address the link was actually sent to, not a foreign key onto
          // `usuarios.email` — see `ITokenUsoUnico` in `src/interfaces/index.ts`
          // for why the column has to be a snapshot: it has to stay what it was
          // at issue time even after the account's address changes, or a token
          // minted for an address the account has since abandoned would still
          // verify it.
          type: DataTypes.STRING(255),
          allowNull: false,
        },
        token_hash: {
          // CHAR(64), not VARCHAR(64): SHA-256 hex is always exactly 64
          // characters, same reasoning `sesiones.token_hash` already carries
          // for the identical kind of value — a wider column buys nothing and
          // a variable-width one would hide a bug writing the wrong shape of
          // value. `unique: true` is this column's index; nothing else queries
          // it by anything but the exact hash.
          type: DataTypes.CHAR(64),
          allowNull: false,
          unique: true,
        },
        proposito: {
          // 'verify_email' | 'reset_password' at the application layer
          // (`ITokenUsoUnico`), plain VARCHAR here rather than a DB ENUM —
          // matching `sesion.mfa_source`'s same choice for the same kind of
          // small, closed set of values.
          type: DataTypes.STRING(32),
          allowNull: false,
        },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          // ⚠️ **This line does not produce a column default, and this comment
          // used to claim it did.** Sequelize 6.37.8 drops `DataTypes.NOW` from
          // `createTable` without a word — only `sequelize.literal("now()")`
          // survives into the SQL. Verified by running this same `createTable`
          // against a scratch database and reading the statement back, so the
          // column shipped with no DEFAULT and this paragraph described a
          // safety net that was not there.
          //
          // The intent was right and it is now real, in raw SQL, in
          // `20260827000001-harden-mfa-schema`: a rescue script or a later
          // task's `INSERT` that forgets the column gets a correct timestamp
          // instead of a NOT NULL violation. Left declared here rather than
          // deleted because this migration has already run and its `up` must
          // keep saying what it did.
          defaultValue: DataTypes.NOW,
        },
      },
      { transaction },
    );

    // Every outstanding token of one person: the email-change path (a later
    // task) deletes them by this, and it is the natural lookup for "does this
    // account have a pending verification".
    await queryInterface.addIndex("token_uso_unico", {
      fields: ["id_usuario"],
      name: "token_uso_unico_id_usuario_idx",
      transaction,
    });

    // The opportunistic purge (`purgeExpiredTokens` in `tokenStore.ts`) sweeps
    // by expiry, same as `sesiones_expires_at_idx`.
    await queryInterface.addIndex("token_uso_unico", {
      fields: ["expires_at"],
      name: "token_uso_unico_expires_at_idx",
      transaction,
    });
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable("token_uso_unico", { transaction });
  });
}
