import { QueryInterface, DataTypes } from "sequelize";

// One row per WebAuthn ceremony in flight: registering a passkey, proving one,
// or logging in with one.
//
// **Why a table of its own, and not two columns on `sesiones`.** The design
// spec puts `webauthn_challenge` and `challenge_expires_at` on the session row,
// and two comments in `auth.controller.ts` still say the next plan will add
// them there. Three separate findings say otherwise, and each one is enough on
// its own:
//
// 1. **A session row has one slot, and this needs N.** Two tabs of the same
//    person — or a registration and a step-up at the same time, which the
//    global interceptor makes ordinary — overwrite each other's cell. The
//    second kills the first, and the ceremony fails with an error that names
//    nothing.
// 2. **Without a purpose there is no way to tell the ceremonies apart**, so a
//    challenge minted to register a credential could be spent completing an
//    authentication. `token_uso_unico.proposito` exists for exactly this and
//    goes inside the same `WHERE` that redeems the token — see
//    `auth/tokenStore.ts`.
// 3. **The passwordless ceremony has no session yet.** Putting the challenge on
//    `sesiones` would mean a session row with no owner, and `sesiones.id_usuario`
//    is NOT NULL in two layers — Sequelize validates before any SQL leaves the
//    process, and `authenticate` answers 401 `CUENTA_INACTIVA` for a null owner,
//    which the front end turns into a logout. Starting a passkey login in one
//    tab would throw the person out of the other one. Here, a null `id_usuario`
//    costs nothing: nothing groups this table by user, no screen lists it, and
//    `authenticate` never reads it.
//
// A stateless HMAC-signed challenge was considered and rejected: it does not
// save the table (single use still has to be written down somewhere) and it
// adds a second key that can be wrong. This repository already pays that price
// once, with `MFA_ENCRYPTION_KEY` and its keyring, boot check and rotation
// script.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a lock
    // should make the migration fail fast and get retried, not queue whatever
    // else is touching `usuarios` behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      "reto_webauthn",
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
        },
        reto_hash: {
          // CHAR(64), not VARCHAR(64): SHA-256 hex is always exactly 64
          // characters — the same reasoning `sesiones.token_hash` and
          // `token_uso_unico.token_hash` already carry for the identical kind
          // of value.
          //
          // **The challenge itself is never stored.** It is a bearer value for
          // the length of one ceremony, and the house rule for those is
          // uniform: the row holds the hash, the caller holds the value, and a
          // database dump proves nothing. `unique: true` is this column's
          // index; nothing ever looks a row up by anything else.
          type: DataTypes.CHAR(64),
          allowNull: false,
          unique: true,
        },
        proposito: {
          // 'registro' | 'segundo_factor' | 'login' at the application
          // layer — see `IRetoWebauthn` for why there is no 'stepup'. Plain VARCHAR rather than a DB ENUM, matching
          // `sesiones.mfa_source` and `token_uso_unico.proposito` for the same
          // kind of small, closed set.
          //
          // 🔴 This column is a security control, not a label. It goes inside
          // the `WHERE` that spends the challenge, so a value minted for one
          // ceremony cannot complete another.
          type: DataTypes.STRING(32),
          allowNull: false,
        },
        id_usuario: {
          // 🔴 **Nullable, and that is the point of the whole table.** Null
          // means the passwordless ceremony, where the credential *is* the
          // identity and nobody is named until the assertion verifies. Every
          // other purpose fills it in.
          type: DataTypes.INTEGER,
          allowNull: true,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          // RESTRICT, matching every FK to `usuarios` added since
          // `20260804000001`. A two-minute challenge is not a reason to block
          // anything for long, and the opportunistic purge clears them.
          onDelete: "RESTRICT",
        },
        id_sesion: {
          // Which session asked, when there is one. Goes inside the redeeming
          // `WHERE` so a challenge issued to one session cannot be spent by
          // another that got hold of it.
          //
          // 🔴 **CASCADE here, unlike the FK above, and the difference is
          // deliberate.** `purgeExpiredSessions` deletes session rows, and
          // RESTRICT would let a two-minute challenge block that purge
          // outright. A challenge whose session no longer exists is worthless
          // by definition, so it should leave with it.
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: "sesiones", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          // 🔴 `sequelize.literal("now()")` and **not** `DataTypes.NOW`.
          // Sequelize 6.37.8 drops the latter from `createTable` without a
          // word — measured in `20260827000001`, which had to repair four
          // tables plus `token_uso_unico`, whose own migration carries a
          // paragraph describing a safety net that was never there. Only the
          // literal survives into the SQL.
          defaultValue: queryInterface.sequelize.literal("now()"),
        },
      },
      { transaction },
    );

    // The opportunistic purge sweeps by expiry, same as
    // `token_uso_unico_expires_at_idx` and `sesiones_expires_at_idx`.
    await queryInterface.addIndex("reto_webauthn", {
      fields: ["expires_at"],
      name: "reto_webauthn_expires_at_idx",
      transaction,
    });

    // **No index on `id_usuario`, unlike `token_uso_unico`.** Said here so the
    // absence reads as a decision rather than an omission: nothing ever asks
    // "which challenges belong to this person". Every read of this table names
    // one `reto_hash`, and the unique index above serves it. An index that no
    // query uses is write cost on the hottest path of the ceremony.
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    // No guard refusing to run when the table has rows, unlike
    // `20260826000003`'s. The difference is what is in it: that one holds
    // second factors that cannot be reconstructed, this one holds challenges
    // that expire in two minutes. Dropping it mid-ceremony fails a handful of
    // logins that will succeed on the next attempt, and nothing else.
    await queryInterface.dropTable("reto_webauthn", { transaction });
  });
}
