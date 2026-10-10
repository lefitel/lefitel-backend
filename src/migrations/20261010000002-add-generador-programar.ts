import { QueryInterface } from "sequelize";

/**
 * `generador.programar` — may this role schedule a saved report to be sent by
 * email? Design: docs/specs/2026-10-10-informes-programados-design.md §1.
 *
 * A permission of its own rather than a reading of `generador.crear`, by
 * decision (Isaias, 10 October 2026): being able to build a report is not
 * the same authority as having it mailed every morning to ten addresses,
 * some of them outside the company.
 *
 * **It is born granted to the Administrador role and denied to every other
 * one**, also by decision that day. Every other cell of `generador` is open
 * to all three roles, and this one deliberately is not: opening it later is
 * one tick on the permissions screen, while closing something people already
 * rely on is a conversation.
 *
 * One row per role that exists, archived ones included, so the screen has a
 * box to tick for each. A role created afterwards gets its row from
 * `seedRolePermissions`, which walks the vocabulary and so needs no change.
 *
 * `ON CONFLICT DO NOTHING` against the table's unique key on
 * `(id_rol, modulo, accion)`: running this twice, or after somebody inserted
 * the row by hand, changes nothing and overwrites no decision.
 */

const MODULO = "generador";
const ACCION = "programar";
/** The Administrador role, as `20260818000001-create-permisos.ts` seeded it. */
const ROL_ADMINISTRADOR = 1;

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `INSERT INTO permisos (id_rol, modulo, accion, permitido, "createdAt", "updatedAt")
       SELECT r.id, :modulo, :accion, (r.id = :admin), now(), now()
         FROM rols r
       ON CONFLICT (id_rol, modulo, accion) DO NOTHING`,
      { replacements: { modulo: MODULO, accion: ACCION, admin: ROL_ADMINISTRADOR }, transaction },
    );
  });
}

/**
 * Removes the cell from every role. Whatever anybody granted from the screen
 * in the meantime goes with it — which is what rolling back a permission
 * means; the schedules themselves are untouched and simply stop being
 * allowed to run.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      "DELETE FROM permisos WHERE modulo = :modulo AND accion = :accion",
      { replacements: { modulo: MODULO, accion: ACCION }, transaction },
    );
  });
}
