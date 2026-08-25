import { QueryInterface, DataTypes } from "sequelize";

// The verified-email columns this feature's later tasks build on: sending a
// verification link, confirming it, and gating password reset on a verified
// address.
//
// `usuarios_user_uniq` is not created here, on purpose. The design spec this
// migration was written from lists it again alongside the email index, but
// it already exists — added by 20260821000001-add-account-lockout.ts and
// already applied to this database (see task-1-report.md for the query that
// checked). Everything in this migration runs in one transaction, so running
// that CREATE UNIQUE INDEX a second time would not just no-op: it would fail
// on "relation already exists" and roll the two new columns back with it.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Same house rule as every other ALTER TABLE on `usuarios`: this table is
    // read on every authenticated request, so a long-running query holding a
    // lock should make the migration fail fast and get retried, not queue
    // every request behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "usuarios",
      "email",
      { type: DataTypes.STRING(255), allowNull: true },
      { transaction },
    );

    await queryInterface.addColumn(
      "usuarios",
      "email_verified_at",
      // DataTypes.DATE is TIMESTAMP WITH TIME ZONE in Postgres. A naive
      // TIMESTAMP compared against a server in UTC would put verification
      // four hours out — the same bug `locked_until` was written to avoid.
      { type: DataTypes.DATE, allowNull: true },
      { transaction },
    );

    // Partial, not a plain column-level `unique: true`. Three reasons, kept
    // here because the next person to read this will want to simplify it:
    //
    // 1. `email_verified_at IS NOT NULL` — an unverified claim must not block
    //    the real owner of a mailbox. Anyone can type someone else's address
    //    into a form; if that alone reserved it, the actual owner could never
    //    register it themselves. Verification has to happen before the
    //    address counts as taken, not after.
    // 2. `"deletedAt" IS NULL` — `usuario` is paranoid (soft-deleted). Without
    //    this clause an archived ex-employee's row would keep their address
    //    reserved forever, and nobody could ever assign it to a replacement's
    //    account.
    // 3. `lower(email)` — a plain UNIQUE compares bytes, and mailboxes do
    //    not: `Isaias@x.com` and `isaias@x.com` are the same address.
    //
    // Raw SQL rather than `addIndex`, matching 20260821000001's index on
    // `user` beside this one: `addIndex` can express both the expression and
    // the WHERE, but the SQL reads more plainly and `down()` needs the same
    // name regardless of which form created it.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX usuarios_email_verificado_uniq
         ON usuarios (lower(email))
         WHERE email_verified_at IS NOT NULL AND "deletedAt" IS NULL`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Same reasoning as in up(): DROP INDEX and the two ALTER TABLEs below all
    // take ACCESS EXCLUSIVE on a table read by every authenticated request,
    // and a rollback tends to happen exactly when something is already wrong
    // and traffic will not politely wait its turn.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query("DROP INDEX IF EXISTS usuarios_email_verificado_uniq", { transaction });
    await queryInterface.removeColumn("usuarios", "email_verified_at", { transaction });
    await queryInterface.removeColumn("usuarios", "email", { transaction });
  });
}
