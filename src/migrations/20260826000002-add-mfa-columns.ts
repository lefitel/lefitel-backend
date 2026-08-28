import { QueryInterface, DataTypes, QueryTypes } from "sequelize";

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

/**
 * Reverses the five columns — **unless `pass_changed_at` has become real.**
 *
 * `removeColumn` takes the column and its data. Re-running `up` afterwards
 * puts the column back and fills it with `"createdAt"`, because that is the
 * only value it has. So a rollback followed by a roll-forward — one deploy
 * window, nobody watching — moves every account's stamp back to the day the
 * account was created.
 *
 * Ana changes her password on the 10th of September; the deploy is undone and
 * redone; her stamp reads 2024 again. And `authenticate`'s condition
 * `sesion.created_at >= usuario.pass_changed_at` is then satisfied by every
 * session that a password change was supposed to have killed — for the whole
 * table, in silence. The braces (revoking sessions explicitly) still hold; this
 * column exists for the day somebody forgets the braces.
 *
 * **Two directions were possible here, and this is the one chosen.** Refusing
 * is the safe one and the annoying one: a rollback stops dead the first time
 * anybody has changed a password, and the operator has to save the column by
 * hand — the failure below says how, in one line of SQL. The softer one was to
 * make the round trip lossless: have `down` copy the column into a side table
 * and a re-run `up` restore from it. That was rejected for two reasons. It
 * needs an edit to an `up` that has already run against the production copy,
 * which this plan does not allow; and it fails in the silent direction — a
 * side table left behind by a rollback months earlier would quietly write
 * stale stamps into a later `up`, which is the same disarming this guard
 * exists to stop, only harder to see.
 *
 * The comparison carries a **one-second tolerance** on purpose. An account
 * created after this migration takes `createdAt` from Sequelize and
 * `pass_changed_at` from the model's own `NOW`: the same INSERT, two clocks,
 * a few milliseconds apart. Compared for exact equality, this guard would
 * refuse every rollback from the first new account onwards while protecting
 * nothing — re-deriving a stamp that is milliseconds off `createdAt` loses no
 * password change. Anything further apart than a second is somebody typing a
 * new password, which no human does within a second of the account existing.
 *
 * Measured on the production copy on 2026-08-27: 15 accounts, 0 divergent. As
 * of today this refuses nothing.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    const [divergencia] = (await queryInterface.sequelize.query(
      `SELECT count(*) AS divergentes
         FROM usuarios
        WHERE pass_changed_at > "createdAt" + interval '1 second'
           OR pass_changed_at < "createdAt" - interval '1 second'`,
      { transaction, type: QueryTypes.SELECT },
    )) as unknown as { divergentes: string | number }[];

    // `count(*)` is a BIGINT and node-postgres hands those over as strings.
    // `"0" > 0` is false, so the comparison below would survive without this
    // — the conversion is here so the guard does not rest on that coercion,
    // and so the value going into the message is a number. What it is *not*
    // is decoration: written as a truthiness test, `"0"` would refuse every
    // rollback for ever. `20260826000003`'s guard is the one where that
    // mistake is reachable, and it has a test standing on it.
    const divergentes = Number(divergencia?.divergentes ?? 0);
    if (divergentes > 0) {
      throw new Error(
        `Deshacer esta migración borraría la fecha de cambio de contraseña de ` +
          `${divergentes} cuenta(s), y volver a aplicarla la reescribiría con la fecha ` +
          "de creación de cada cuenta. El efecto es que las sesiones anteriores a un " +
          "cambio de contraseña vuelven a valer, en silencio y para toda la tabla. " +
          "Si aun así hay que deshacerla, guarda la columna primero: " +
          'CREATE TABLE usuarios_pass_changed_at_bak AS SELECT id, pass_changed_at FROM usuarios; ' +
          "y, después del siguiente up, devuélvela: " +
          'UPDATE usuarios u SET pass_changed_at = b.pass_changed_at ' +
          "FROM usuarios_pass_changed_at_bak b WHERE b.id = u.id; " +
          "Revoca además las sesiones vivas de esas cuentas, porque entre el down y " +
          "la restauración la comprobación no protege nada.",
      );
    }

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
