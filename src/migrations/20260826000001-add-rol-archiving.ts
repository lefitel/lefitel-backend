import { QueryInterface, DataTypes } from "sequelize";

// Gives `rols` the soft delete every other manageable table in this schema
// already has, because deleting a role here does not delete a role.
//
// `rols` was the one table with no `deletedAt`, so `RolModel.destroy()` — which
// is what `DELETE /api/rol/:id` calls — issues a real DELETE. And
// `usuarios.id_rol` is ON DELETE CASCADE. The chain has been measured, and the
// number is written down in 20260822000001-create-sesion.ts, which chose
// RESTRICT for sessions specifically to stay out of it: deleting one role took
// **six users and 4.835 revisions** with it, through seventeen cascading keys.
// So the endpoint that reads as "archive this role" is really "delete this role,
// everyone who holds it, and every field inspection any of them ever recorded",
// and the single line it writes to the audit log says `Eliminó rol #4` — nothing
// about the people.
//
// Nothing has been lost to it yet for one reason only: no screen calls it. That
// stops being true the moment role management reaches the interface, which is
// what this column is a prerequisite for.
//
// The column alone does not fix it — `paranoid: true` on the model is what turns
// `destroy()` into an UPDATE, and a guard in the controller is what refuses to
// archive a role somebody still holds. This is the first of the three, and the
// only one that needs the database.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule for every ALTER TABLE here. `rols` is small and read
    // rarely, so this lock is not the one that would hurt — but a migration
    // that fails fast and gets retried beats one that queues requests behind
    // it, and the rule is worth keeping uniform rather than argued per table.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "rols",
      "deletedAt",
      // DataTypes.DATE is TIMESTAMP WITH TIME ZONE in Postgres, matching every
      // other `deletedAt` in this schema. A naive TIMESTAMP against a server in
      // UTC would archive things four hours out.
      { type: DataTypes.DATE, allowNull: true },
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    // Rolling back drops the archived flag, so any role archived while this
    // migration was applied comes back visible rather than staying hidden with
    // nothing to explain it. That is the safer direction of the two: a role that
    // reappears is a nuisance, a role that vanishes takes its permission matrix
    // out of every screen that lists it.
    await queryInterface.removeColumn("rols", "deletedAt", { transaction });
  });
}
