import { QueryInterface, DataTypes } from "sequelize";

// One row per open session, so a session can be ended.
//
// The token itself is never stored: only its SHA-256. A leaked dump of this
// table therefore hands over nothing that can be used to log in — which is the
// whole difference between this and a JWT, whose bearer token *is* the thing
// the server verifies.
//
// Table name set explicitly. Sequelize's pluralisation has already produced
// `ciudads`, `rols` and `revicions` in this schema.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // `authenticateToken` reads this table on every request from the moment it
    // exists. Creating it takes no lock worth worrying about, but the timeout
    // is the house rule for every migration here and a later ALTER on this
    // table will need it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      "sesiones",
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
          // RESTRICT, not CASCADE. Deleting a role in this schema has been
          // measured taking 6 users and 4835 revisions with it through
          // seventeen cascading keys; sessions are not joining that chain.
          // Ending a user's sessions is code's job, and it is explicit.
          onDelete: "RESTRICT",
        },
        token_hash: {
          // SHA-256 in hex: always 64 characters. Not bcrypt — the token is
          // already 32 random bytes, there is no entropy to stretch, and this
          // row is read on every single request.
          type: DataTypes.CHAR(64),
          allowNull: false,
          unique: true,
        },
        user_agent: {
          // So a person recognises their own session in the list before ending
          // it. Postgres does not truncate an oversized value — it rejects the
          // insert with error 22001 — so whatever writes this column (the
          // session store, a later task) is the one responsible for cutting a
          // browser's absurdly long string down to size first.
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        ip_address: {
          // 45 characters: the longest an IPv6 address gets, including a mapped
          // IPv4 tail.
          type: DataTypes.STRING(45),
          allowNull: true,
        },
        created_at: { type: DataTypes.DATE, allowNull: false },
        last_used_at: { type: DataTypes.DATE, allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    // Every session of one person: the profile screen lists them, logging out
    // everywhere revokes them, and the rescue script reaches them.
    await queryInterface.addIndex("sesiones", {
      fields: ["id_usuario"],
      name: "sesiones_id_usuario_idx",
      transaction,
    });

    // The purge sweeps by expiry.
    await queryInterface.addIndex("sesiones", {
      fields: ["expires_at"],
      name: "sesiones_expires_at_idx",
      transaction,
    });
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable("sesiones", { transaction });
  });
}
