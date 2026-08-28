import { QueryInterface, DataTypes, QueryTypes } from "sequelize";

// The four tables the second factor lives in.
//
// ⚠️ **They are created empty, and they are read on every single login.** The
// first version of this header said only the first half — "created empty;
// nothing reads them until plans 4B and 4C" — and that stopped being true four
// tasks later, inside this same plan. Whoever deploys reads this comment and
// not `factorInventory.ts`, so the correction belongs here:
//
// `tieneAlgunFactor` (`auth/factorInventory.ts`) runs one COUNT against
// `credencial_webauthn` and another against `factor_totp`.
// `estadoInicialDeSesion` calls it to decide which state a session opens in,
// and `POST /api/auth/login` calls that on every login.
//
// **So undoing this migration on its own takes the whole ERP down.** `umzug
// down` with no arguments reverts exactly one migration, and this is the later
// of the pair: the columns added by `20260826000002` stay, the deployed code
// stays, and the next login COUNTs a table that is no longer there. Measured
// on a scratch database: `no existe la relación credencial_webauthn`.
//
// That rejection is raised **outside** the try/catch that answers 503 — see
// `auth.controller.ts`, where the call deliberately sits above it — so what
// every login gets is a 500: no cookie, no session, and no sentence anybody
// can act on. For all fifteen accounts, until somebody runs `up` again.
//
// **If this ever has to come out, the code goes first.** Either deploy a build
// whose login path does not read these tables, or revert `20260826000002` in
// the same window. On its own, with the API running, this migration is not
// safely reversible — no matter how empty the tables are.
//
// `down` below refuses to destroy data. That is a *different* guard and it
// does not cover this one: while the tables are still empty it lets the
// rollback through, and the 500s start on the next login.
//
// Two things about the shape below have been corrected since, in
// `20260827000001-harden-mfa-schema.ts` rather than by editing this file,
// which has already run: `credential_id` is capped at 1364 characters (TEXT
// under a unique btree breaks past ~2692 bytes of incompressible data), and
// the four `created_at` columns gained a real `DEFAULT now()`.
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

/** The four, in the order `down` has to drop them. */
const TABLAS = [
  "dispositivo_recordado",
  "codigo_recuperacion",
  "factor_totp",
  "credencial_webauthn",
] as const;

/**
 * Drops the four tables — **unless any of them still holds a row.**
 *
 * `dropTable` asks nobody, and what is in these tables does not exist anywhere
 * else. A TOTP secret was shown exactly once, as a QR code, and the plaintext
 * was never stored: a dropped `factor_totp` is not a restore away, it is every
 * one of those accounts locked out of their own second factor. Same for the
 * passkeys, the unredeemed recovery codes and the remembered devices.
 *
 * And the rollback would be **half** a rollback anyway: the session columns
 * that go with these tables live in `20260826000002`, so reverting this one
 * leaves `sesiones.estado` in place. Nothing about this pair comes undone in
 * one step.
 *
 * So the guard is a refusal rather than a warning. With the tables empty —
 * which is the state 4A ships in — it lets the rollback through untouched, and
 * 4A stays reversible. Once a single factor is registered, undoing this needs a
 * person to decide, in writing, that the data goes. The failure says how.
 *
 * ⚠️ **An empty-table rollback still breaks every login.** That is the other
 * hazard, it is not this guard's, and it is written at the top of this file.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    // **Before the count, not between the count and the drops.** Counting takes
    // ACCESS SHARE and dropping takes ACCESS EXCLUSIVE; on its own, nothing
    // holds the tables in the gap between them, and the guard below is then
    // deciding on a number that can already be stale. Reproduced against a
    // scratch database with a second connection in that window: the guard saw
    // `factor_totp=0`, a TOTP secret was registered and committed after the
    // count, and the drop took it. Milliseconds wide, and it needs the API
    // alive during a rollback — which the header of this file already calls a
    // total outage — but "small window" is not the same as "closed".
    //
    // Taking the strongest lock first also puts `lock_timeout` to work at the
    // right moment: if anything is using these tables, this fails fast and gets
    // retried instead of counting a table it is about to lose a race with.
    await queryInterface.sequelize.query(
      `LOCK TABLE ${TABLAS.join(", ")} IN ACCESS EXCLUSIVE MODE`,
      { transaction },
    );

    // One statement for the four, so the answer is a single consistent
    // snapshot inside this transaction rather than four that could disagree.
    const conteos = (await queryInterface.sequelize.query(
      TABLAS.map((t) => `SELECT '${t}' AS tabla, count(*) AS filas FROM ${t}`).join(" UNION ALL "),
      { transaction, type: QueryTypes.SELECT },
    )) as unknown as { tabla: string; filas: string | number }[];

    // `Number(...)`, because `count(*)` is a BIGINT and node-postgres hands
    // those back as strings. `"0" > 0` is false but `"0"` is truthy, so a
    // guard written the obvious way refuses every rollback for ever.
    const conFilas = conteos.filter((c) => Number(c.filas) > 0);
    if (conFilas.length > 0) {
      const detalle = conFilas.map((c) => `${c.tabla} (${c.filas})`).join(", ");
      throw new Error(
        `Deshacer esta migración destruiría datos irrecuperables: ${detalle}. ` +
          "Los secretos TOTP no existen en ningún otro sitio — el texto plano se " +
          "enseñó una sola vez, como código QR — y con ellos se van las passkeys, " +
          "los códigos de recuperación sin usar y los dispositivos recordados. " +
          "Si de verdad tienen que irse: exporta esas tablas primero " +
          "(pg_dump -t credencial_webauthn -t factor_totp -t codigo_recuperacion " +
          "-t dispositivo_recordado), bórralas a mano y vuelve a ejecutar el down. " +
          "Y antes de deshacer nada, lee la cabecera de este fichero: con la API " +
          "en marcha, deshacer esta migración sola hace que todos los logins " +
          "respondan 500.",
      );
    }

    for (const tabla of TABLAS) {
      await queryInterface.dropTable(tabla, { transaction });
    }
  });
}
