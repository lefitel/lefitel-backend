import { QueryInterface } from "sequelize";

// The person in charge of a tramo (`docs/specs/2026-10-31-encargado-de-tramo-design.md`).
//
// One per tramo, the current one: no history, by Isaias' decision. Who it was
// before is in the bitácora and nowhere else.
//
// A column of its own and not `id_usuario`, which is the tramo's author — shown
// behind `seguridad.ver` — while the encargado is shown to anyone who sees the
// tramo. Nullable with no default: every tramo starts with nobody in charge,
// and adding such a column touches the catalogue only, not the rows.
//
// `SET NULL` as `id_usuario` has it. Users are archived, never deleted, so it
// only fires on a delete by hand; archiving somebody in charge is refused until
// their tramos are released (`deleteUsuario`).

const TABLA = "tramos";
export const RESTRICCION = "tramos_id_encargado_fkey";
export const INDICE = "idx_tramos_encargado";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule for every statement that takes a lock on a table.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE ${TABLA} ADD COLUMN "id_encargado" INTEGER NULL` +
      ` CONSTRAINT ${RESTRICCION} REFERENCES usuarios (id) ON UPDATE CASCADE ON DELETE SET NULL`,
      { transaction },
    );
    // The user's ficha and the archive check both ask "which tramos does this
    // person carry".
    await queryInterface.sequelize.query(
      `CREATE INDEX ${INDICE} ON ${TABLA} ("id_encargado")`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    // The column takes its foreign key and its index with it.
    await queryInterface.sequelize.query(`ALTER TABLE ${TABLA} DROP COLUMN IF EXISTS "id_encargado"`, { transaction });
  });
}
