import { QueryInterface, DataTypes } from "sequelize";

// Session states, the MFA grace deadline, and the moment each password started
// being the current one.
//
// **`pass_changed_at` is back-filled from `usuarios."createdAt"`, not left at
// its `now()` default.** The default is right for rows created from here on —
// a new account's password is new — but wrong for the rows that already
// exist. `authenticate` gains the condition `sesion.created_at >=
// usuario.pass_changed_at`, and with `now()` in that column every session
// alive on deploy day was created *before* it: the whole company is logged
// out at once, by a column whose only job is to invalidate sessions older
// than a password change that, for these rows, never happened.
//
// **`estado` arrives with a default of `completa`** for the same reason from
// the other side: the sessions that exist were opened when states did not,
// and in the only sense that existed then they were complete. A default of
// `parcial` would have been the same outage wearing a different name.
//
// The CHECK constraints are not decoration. `sessionState.ts` compares these
// strings as literals; a row carrying `completo` or `pasarela` instead would
// fall through every comparison and be treated as the *least* privileged
// state by the allowlist — silently, and only for whoever wrote it.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a lock
    // should make the migration fail fast and get retried, not queue whatever
    // else is touching `usuarios` behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "usuarios",
      "mfa_grace_until",
      {
        // Born NULL and set at the first successful login *after* deploy, not
        // filled in here with "deploy + 14 days". Somebody on holiday would
        // come back on day 30 to a grace period that expired without them
        // seeing a single screen: zero of their fourteen days.
        type: DataTypes.DATE,
        allowNull: true,
      },
      { transaction },
    );

    await queryInterface.addColumn(
      "usuarios",
      "pass_changed_at",
      {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: queryInterface.sequelize.literal("now()"),
      },
      { transaction },
    );

    // Postgres 11+ adds a NOT NULL column with a default without rewriting the
    // table, so this is two fast statements rather than one long lock.
    await queryInterface.sequelize.query(
      'UPDATE usuarios SET pass_changed_at = "createdAt" WHERE "createdAt" IS NOT NULL',
      { transaction },
    );

    await queryInterface.addColumn(
      "sesiones",
      "estado",
      { type: DataTypes.STRING(20), allowNull: false, defaultValue: "completa" },
      { transaction },
    );

    await queryInterface.addColumn(
      "sesiones",
      "mfa_satisfied_at",
      {
        // Written **only** by a live proof of a factor. A login that came in
        // on a remembered device leaves this NULL on purpose: if it were
        // stamped, every remembered login would open ten minutes of
        // already-satisfied step-up, and stealing that cookie plus the
        // password would be enough to edit the permission matrix without
        // touching a single factor.
        type: DataTypes.DATE,
        allowNull: true,
      },
      { transaction },
    );

    await queryInterface.addColumn(
      "sesiones",
      "mfa_source",
      { type: DataTypes.STRING(20), allowNull: true },
      { transaction },
    );

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ADD CONSTRAINT sesiones_estado_chk " +
        "CHECK (estado IN ('parcial', 'onboarding', 'completa'))",
      { transaction },
    );

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ADD CONSTRAINT sesiones_mfa_source_chk " +
        "CHECK (mfa_source IS NULL OR mfa_source IN ('passkey', 'totp', 'codigo', 'dispositivo'))",
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    // Constraints first: dropping a column a CHECK still references fails.
    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_mfa_source_chk",
      { transaction },
    );
    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_estado_chk",
      { transaction },
    );

    await queryInterface.removeColumn("sesiones", "mfa_source", { transaction });
    await queryInterface.removeColumn("sesiones", "mfa_satisfied_at", { transaction });
    await queryInterface.removeColumn("sesiones", "estado", { transaction });
    await queryInterface.removeColumn("usuarios", "pass_changed_at", { transaction });
    await queryInterface.removeColumn("usuarios", "mfa_grace_until", { transaction });
  });
}
