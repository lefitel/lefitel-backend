import { QueryInterface, DataTypes } from "sequelize";

/**
 * `sesiones.password_confirmed_at` — when this session last confirmed its
 * password.
 *
 * **This is not `mfa_satisfied_at`, and it cannot be.** That column means
 * "this session proved a FACTOR", and `estadoEfectivo`
 * (`auth/sessionState.ts:428`) reads it to decide that an account with a
 * factor has nothing left to set up. If a password confirmation wrote to
 * this column instead, an account with no factor at all that typed its
 * password once would read as `completa` past the fourteen-day grace
 * deadline — the very outage `mfa_grace_until` exists to prevent. Four
 * auditors found that independently on 2026-09-08.
 *
 * **NULL, no default, no back-fill — on purpose.** For every session that
 * already exists, "has not confirmed its password this session" is the
 * correct answer.
 *
 * **Nothing sets it back to NULL.** Every place that invalidates a session
 * calls `revokeAllSessionsOf`, and `findLiveSession`
 * (`auth/sessionStore.ts:155-161`) excludes rows with `revoked_at IS NOT
 * NULL`: the column dies with the row instead of being cleared.
 */
export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Same house rule as every other migration here: fail fast on a lock
    // instead of queuing behind whatever else is touching `sesiones`.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "sesiones",
      "password_confirmed_at",
      { type: DataTypes.DATE, allowNull: true },
      { transaction },
    );
  });
}

/**
 * Drops the column. No data guard, unlike `pass_changed_at`'s: this column
 * is new and nothing else in this migration set reads or writes it, so a
 * rollback loses nothing but the requirement to confirm again — which is
 * the same state every session starts in today.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.removeColumn("sesiones", "password_confirmed_at", { transaction });
  });
}
