import { QueryInterface, QueryTypes } from "sequelize";

// No two active roles with the same name, held by the database.
//
// Two roles called "Supervisor" cannot be told apart in the one place it
// matters — the picker that hands a role to an account — and a report filtered
// by role name quietly merges them. `rol.controller.ts` refuses the second one
// before writing, and that is what stops a person making the mistake. It is a
// read followed by a write, though, so two requests arriving together both pass
// it. This is the half that cannot be raced.
//
// **Why it can be created at all.** A unique index cannot be built over rows
// that already clash, and a migration that fails half way through a cutover is
// the failure that costs a night. Role management has never reached production:
// `master` has the table and its three seeded roles — Administrador,
// Coordinador, Cliente — and no screen that creates more. So there is nothing
// there to clash. That is a statement about a database this file cannot see,
// which is why `up` looks before it builds, and stops with the names in its
// message rather than with Postgres's "could not create unique index".
//
// **What it covers, exactly.**
//   - `lower(name)`: "supervisor" and "Supervisor" are the same word to whoever
//     is choosing between them. The controller compares the same way.
//   - `WHERE "deletedAt" IS NULL`: an archived role keeps its name and is in
//     nobody's way. Bringing it back is where a clash would surface, and
//     `desarchivarRol` asks first.
//   - A role with no name is not constrained. NULLs never equal each other in a
//     unique index, so several can coexist — the controller is what refuses to
//     make another one, and this migration does not pretend to.

const INDICE = "rols_nombre_activo_uniq";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule for every statement that takes a lock on a table. `rols`
    // is a handful of rows, so this is not the lock that would hurt; the rule
    // is kept uniform rather than argued per table.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    const repetidos = await queryInterface.sequelize.query<{ nombre: string; veces: string }>(
      `SELECT lower(name) AS nombre, count(*) AS veces
         FROM rols
        WHERE "deletedAt" IS NULL AND name IS NOT NULL
        GROUP BY lower(name)
       HAVING count(*) > 1
        ORDER BY 1`,
      { type: QueryTypes.SELECT, transaction },
    );
    if (repetidos.length > 0) {
      const lista = repetidos.map((r) => `«${r.nombre}» (${r.veces})`).join(", ");
      throw new Error(
        `No se puede crear el índice único de nombres de rol: hay roles activos con el mismo nombre — ${lista}. ` +
        "Renombra o archiva los que sobren y vuelve a ejecutar la migración. No se ha cambiado nada.",
      );
    }

    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX ${INDICE}
           ON rols (lower(name))
        WHERE "deletedAt" IS NULL`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    // Nothing to put back: without the index the controller's check is all
    // that stands, which is how it was. `IF EXISTS` so a rollback that is run
    // twice, or after a failed `up`, does not fail in turn.
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${INDICE}`, { transaction });
  });
}
