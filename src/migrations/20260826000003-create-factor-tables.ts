import { QueryInterface, DataTypes } from "sequelize";

// The four tables the second factor lives in. Created empty; nothing reads
// them until plans 4B and 4C.
//
// Table names are set explicitly, same reason as `sesiones` and
// `token_uso_unico`: Sequelize's default pluralisation has already produced
// `ciudads`, `rols` and `revicions` in this schema.
//
// Every foreign key is RESTRICT. `usuarios` is `paranoid: true`, so the row is
// never really deleted and no cascade ever fires — a CASCADE written here
// would read as cleanup that happens and does not. What actually has to
// revoke a user's factors when they are archived is `deleteUsuario`, in code,
// inside the same transaction (Task 9).

/** Shared by the four tables: the owner column, spelled once. */
const OWNER = {
  type: DataTypes.INTEGER,
  allowNull: false,
  references: { model: "usuarios", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "RESTRICT",
} as const;

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      "credencial_webauthn",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_usuario: { ...OWNER },
        // base64url, and unique across the whole table rather than per user: an
        // assertion arrives naming only its credential, so the lookup has no
        // user to scope by. Two rows sharing an id would let the server verify
        // a signature against a key that did not produce it — possibly one
        // belonging to another account.
        credential_id: { type: DataTypes.TEXT, allowNull: false, unique: true },
        public_key: { type: DataTypes.BLOB, allowNull: false },
        // BIGINT because the spec's counter rule compares it, and some
        // authenticators count into the millions over a device's life.
        counter: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        transports: { type: DataTypes.STRING(255), allowNull: true },
        // The person writes this: "mi móvil", "PC oficina". It is what makes
        // the list on the profile screen mean anything, and what makes an
        // unexpected passkey recognisable as unexpected.
        nombre: { type: DataTypes.STRING(100), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false },
        last_used_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.createTable(
      "factor_totp",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        // Unique: one TOTP factor per account. Two rows would mean two secrets
        // that both open the door, and a "remove my TOTP" that removes one of
        // them.
        id_usuario: { ...OWNER, unique: true },
        secreto_cifrado: { type: DataTypes.BLOB, allowNull: false },
        // Both NOT NULL, and both useless as an afterthought: AES-256-GCM
        // cannot decrypt without the nonce, and cannot be trusted without the
        // tag. A row missing either is a secret nobody can ever recover.
        iv: { type: DataTypes.BLOB, allowNull: false },
        auth_tag: { type: DataTypes.BLOB, allowNull: false },
        // Without this, rotating MFA_ENCRYPTION_KEY is impossible to do
        // halfway: there is no way to tell which rows were re-encrypted.
        key_version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
        // Anti-replay: the last accepted time step. A code stays valid for its
        // whole window, so without this the same six digits work twice.
        ultimo_paso: { type: DataTypes.BIGINT, allowNull: true },
        // NULL until the person has typed a code back. An unconfirmed factor
        // must not satisfy anything: it is a secret they may never have
        // managed to scan.
        confirmed_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );

    await queryInterface.createTable(
      "codigo_recuperacion",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_usuario: { ...OWNER },
        // bcrypt, not SHA-256 — the opposite choice from `sesiones.token_hash`,
        // and deliberately. A session token is 32 random bytes; there is no
        // entropy to reinforce and the comparison runs on every request. A
        // recovery code is short enough to be written on paper, so a fast hash
        // plus a stolen database dump is an offline break in hours.
        codigo_hash: { type: DataTypes.STRING(60), allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );

    await queryInterface.createTable(
      "dispositivo_recordado",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        // NOT NULL, and this is the security property of the table. With the
        // check done on the hash alone, ticking "remember me" on your own
        // account and carrying that cookie to the administrator's login would
        // skip *their* second factor.
        id_usuario: { ...OWNER },
        token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
        user_agent: { type: DataTypes.STRING(255), allowNull: true },
        ip_address: { type: DataTypes.STRING(45), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    // BYTEA has no length in Postgres, so the sizes GCM depends on can only be
    // enforced here.
    await queryInterface.sequelize.query(
      "ALTER TABLE factor_totp ADD CONSTRAINT factor_totp_iv_len_chk CHECK (octet_length(iv) = 12)",
      { transaction },
    );
    await queryInterface.sequelize.query(
      "ALTER TABLE factor_totp ADD CONSTRAINT factor_totp_tag_len_chk CHECK (octet_length(auth_tag) = 16)",
      { transaction },
    );

    await queryInterface.addIndex("credencial_webauthn", { fields: ["id_usuario"], transaction });
    await queryInterface.addIndex("codigo_recuperacion", { fields: ["id_usuario"], transaction });
    await queryInterface.addIndex("dispositivo_recordado", { fields: ["id_usuario"], transaction });
    // The purge filters by this one, and it runs against every row in the table.
    await queryInterface.addIndex("dispositivo_recordado", { fields: ["expires_at"], transaction });
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable("dispositivo_recordado", { transaction });
    await queryInterface.dropTable("codigo_recuperacion", { transaction });
    await queryInterface.dropTable("factor_totp", { transaction });
    await queryInterface.dropTable("credencial_webauthn", { transaction });
  });
}
