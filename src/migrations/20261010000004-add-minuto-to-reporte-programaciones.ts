import { QueryInterface } from "sequelize";

// A scheduled report runs at an hour **and a minute**.
//
// `20261010000001` gave a schedule an hour of the day and nothing finer, on the
// reasoning that nobody needs a report at 07:20. Isaias asked for exactly that
// the first time he saw the form: the hours on the dot stay as shortcuts, and
// the time itself is whatever is typed.
//
// A column of its own rather than `hora` turned into minutes of the day: every
// row already written reads the same as before, and so does every query that
// names `hora`. `DEFAULT 0` is what those rows meant all along — on the dot.
//
// The scheduler looks once a minute, so a minute is as fine as a schedule can
// honestly be. Nothing here promises seconds.

const TABLA = "reporte_programaciones";
export const RESTRICCION = "reporte_programaciones_minuto_chk";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule for every statement that takes a lock on a table.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE ${TABLA} ADD COLUMN minuto SMALLINT NOT NULL DEFAULT 0`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE ${TABLA} ADD CONSTRAINT ${RESTRICCION} CHECK (minuto BETWEEN 0 AND 59)`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    // Dropping the column takes its CHECK with it. A schedule set for 07:20
    // goes back to 07:00 — and its `proxima_ejecucion`, already computed,
    // still fires once at :20 before the hour alone decides the next one.
    await queryInterface.sequelize.query(`ALTER TABLE ${TABLA} DROP COLUMN IF EXISTS minuto`, { transaction });
  });
}
