import { QueryInterface } from "sequelize";

/**
 * The `tramos` module on the permission matrix. Design:
 * docs/specs/2026-10-10-tramo-como-entidad-design.md §5.4.
 *
 * Each role is born with what it holds today on `ciudades`, cell by cell: who
 * could create a city can create a stretch between two. Read from the live
 * rows rather than from the three roles the first migration seeded, because
 * the screen that makes new roles ships in this same cut.
 *
 * One row per role that exists, archived ones included, so the screen has a
 * box for each. A role with no `ciudades` row for an action gets `false`.
 * `ON CONFLICT DO NOTHING` so a second run overwrites no decision.
 *
 * Its own file, after the one that changes the schema: if this one fails the
 * schema stays migrated and the module is simply closed to everybody, which is
 * the safe direction. Run it again.
 */
export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `INSERT INTO permisos (id_rol, modulo, accion, permitido, "createdAt", "updatedAt")
       SELECT r.id, 'tramos', a.accion, COALESCE(p.permitido, false), now(), now()
         FROM rols r
        CROSS JOIN unnest(ARRAY['ver', 'crear', 'editar', 'archivar']) AS a(accion)
         LEFT JOIN permisos p ON p.id_rol = r.id AND p.modulo = 'ciudades' AND p.accion = a.accion
       ON CONFLICT (id_rol, modulo, accion) DO NOTHING`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query("DELETE FROM permisos WHERE modulo = 'tramos'", { transaction });
  });
}
