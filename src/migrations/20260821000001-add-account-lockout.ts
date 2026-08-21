import { QueryInterface, DataTypes } from "sequelize";

// Per-account lockout, and the unique index on `user` that the previous audit
// left open.
//
// They travel together because they are the same ALTER on the same table, and
// because they answer the same question from two sides: who is allowed to try,
// and which row they are trying against.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  // One transaction for the whole migration. Postgres supports transactional
  // DDL, and without it a failure on the index would leave the columns added
  // but the migration unrecorded in SequelizeMeta: the next deploy re-runs
  // `up`, hits "column already exists" and crash-loops until someone
  // intervenes by hand.
  await queryInterface.sequelize.transaction(async (transaction) => {
    // ALTER TABLE takes ACCESS EXCLUSIVE, and `authenticateToken` reads this
    // table on every request. A long-running report holding a connection would
    // make the ALTER wait, and every request would queue behind it. Better to
    // fail fast and retry when the database is quiet.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "usuarios",
      "failed_attempts",
      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      { transaction },
    );

    // DataTypes.DATE is TIMESTAMP WITH TIME ZONE in Postgres, which is what the
    // rest of this schema uses. A naive TIMESTAMP compared against a server in
    // UTC would be four hours out and the lockout would never bite.
    await queryInterface.addColumn(
      "usuarios",
      "locked_until",
      { type: DataTypes.DATE, allowNull: true },
      { transaction },
    );

    // Case-insensitive because `Isaias` and `isaias` are the same person to
    // everyone except a byte comparison, and partial because the model is
    // paranoid: an archived account keeps its row, and its username has to
    // become available again.
    //
    // Raw SQL rather than addIndex: queryInterface *can* express both the
    // lower("user") expression and the WHERE clause (addIndex takes a `where`
    // option, and its column list accepts sequelize.fn/literal) — this is not
    // a limitation being worked around. The SQL is just more readable than
    // the equivalent addIndex call would be, and down() has to reference this
    // same index name regardless of which form built it.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX usuarios_user_uniq
         ON usuarios (lower("user"))
         WHERE "deletedAt" IS NULL`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Same reasoning as in up(): DROP INDEX and the two ALTER TABLEs below all
    // take ACCESS EXCLUSIVE on a table read by every authenticated request,
    // and a rollback tends to happen exactly when something is already wrong
    // and traffic is not going to politely wait its turn.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query("DROP INDEX IF EXISTS usuarios_user_uniq", { transaction });
    await queryInterface.removeColumn("usuarios", "locked_until", { transaction });
    await queryInterface.removeColumn("usuarios", "failed_attempts", { transaction });
  });
}
