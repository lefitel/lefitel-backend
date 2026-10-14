import { DataTypes, QueryInterface, QueryTypes, Transaction } from "sequelize";
import { DEPARTAMENTOS } from "../models/departamento.model.js";

// The tramo becomes a row of its own. Design:
// docs/specs/2026-10-10-tramo-como-entidad-design.md §5.4.
//
// Until now a pole stored two cities and the tramo was whatever grouping them
// produced, so Sucre→Potosí and Potosí→Sucre were two pairs: 20 of the 91
// stretches existed twice. This derives one row per unordered pair, points
// every pole at it, and drops the two columns.
//
// **It also merges five cities that were loaded twice**, before deriving
// anything, because a duplicated city is the other way the same stretch came to
// exist more than once and no change of model fixes that. The pairs and the
// survivor of each were decided with the coordinates in front of us (§2.2).
//
// **It looks before it changes anything.** Everything it assumes about the data
// was measured on a copy, and this file cannot see production. Each assumption
// is a query at the top; if one does not hold it stops with the rows in its
// message, having written nothing.
//
// **There is no exact way back.** `down` rebuilds the two columns from the
// tramo, which gives every pole its pair in id order — not the order it had —
// and it does not un-merge the cities. The way back is the backup taken before
// the cut. The previous image must be stopped before this runs: it selects the
// two columns in every pole, incident and report query.

/** City `pierde` is a duplicate of `gana`; its poles move and it is archived. */
export const FUSIONES = [
  { pierde: 77, gana: 58, nombre: "Millares" },
  { pierde: 78, gana: 59, nombre: "Olivos" },
  { pierde: 76, gana: 57, nombre: "El Morro" },
  { pierde: 79, gana: 60, nombre: "Ventillas" },
  { pierde: 86, gana: 98, nombre: "Pailas" },
] as const;

export const RESTRICCIONES = {
  orden: "tramos_extremos_en_orden_chk",
  parUnico: "tramos_par_uniq",
} as const;

const NADA = "No se ha cambiado nada.";
const limpio = `btrim(regexp_replace(name, '\\s+', ' ', 'g'))`;

/** A city id as it will be once the merge has run. */
const fusionada = (columna: string) =>
  `(CASE ${columna} ${FUSIONES.map((f) => `WHEN ${f.pierde} THEN ${f.gana}`).join(" ")} ELSE ${columna} END)`;

async function comprobar(queryInterface: QueryInterface, transaction: Transaction) {
  const leer = <T extends object>(sql: string) =>
    queryInterface.sequelize.query<T>(sql, { type: QueryTypes.SELECT, transaction });

  const ids = FUSIONES.flatMap((f) => [f.pierde, f.gana]);
  const ciudades = await leer<{ id: number; name: string | null; deletedAt?: Date | null }>(
    `/* fusion */ SELECT id, ${limpio} AS name, "deletedAt" FROM ciudads WHERE id IN (${ids.join(", ")})`,
  );
  const porId = new Map(ciudades.map((c) => [c.id, c.name]));
  const raras = FUSIONES.flatMap((f) => [f.pierde, f.gana].filter((id) => porId.get(id) !== f.nombre).map((id) =>
    `${id} (se esperaba «${f.nombre}», hay ${porId.has(id) ? `«${porId.get(id)}»` : "nada"})`));
  if (raras.length > 0) {
    throw new Error(`La fusión de ciudades no cuadra con esta base: ${raras.join(", ")}. ${NADA}`);
  }

  // A loser may already be archived; a winner may not, or its poles would be
  // moved onto an archived city.
  const archivadas = FUSIONES.map((f) => f.gana).filter((id) => ciudades.find((c) => c.id === id)?.deletedAt != null);
  if (archivadas.length > 0) {
    throw new Error(`Ciudades que deben quedar activas están archivadas: ${archivadas.join(", ")}. ${NADA}`);
  }

  const huerfanos = await leer<{ id: number }>(
    `/* huerfanos */ SELECT p.id FROM postes p
      WHERE NOT EXISTS (SELECT 1 FROM ciudads c WHERE c.id = p."id_ciudadA")
         OR NOT EXISTS (SELECT 1 FROM ciudads c WHERE c.id = p."id_ciudadB")
      ORDER BY p.id LIMIT 50`,
  );
  if (huerfanos.length > 0) {
    throw new Error(`Hay postes que apuntan a una ciudad inexistente: ${huerfanos.map((p) => p.id).join(", ")}. ${NADA}`);
  }

  const misma = await leer<{ id: number }>(
    `/* misma */ SELECT id FROM postes
      WHERE ${fusionada('"id_ciudadA"')} = ${fusionada('"id_ciudadB"')} ORDER BY id LIMIT 50`,
  );
  if (misma.length > 0) {
    throw new Error(
      `Hay postes con la misma ciudad en los dos extremos, y un tramo une dos distintas: ${misma.map((p) => p.id).join(", ")}. ` +
      `Corrige su ciudad y vuelve a ejecutar. ${NADA}`,
    );
  }

  // Archived views too: they can be restored. `ciudad[AB]` anywhere in the
  // configuration, or a filter on a path ending in `tramo` — that one compares
  // the rendered text, which is about to change.
  const informes = await leer<{ id: number; name: string }>(
    `/* informes */ SELECT id, name FROM reporte_vistas
      WHERE config::text ~ 'ciudad[AB]'
         OR jsonb_path_exists(config, '$.filters.** ? (@.path like_regex "(^|[.])tramo$")')
      ORDER BY id`,
  );
  if (informes.length > 0) {
    throw new Error(
      `Hay informes guardados que usan «Ciudad A/B» o filtran por el texto del tramo: ` +
      `${informes.map((i) => `#${i.id} «${i.name}»`).join(", ")}. Edítalos para quitar esa columna o ese filtro (archivarlos no basta: los archivados también cuentan) y vuelve a ejecutar. ${NADA}`,
    );
  }
}

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const sql = (texto: string) => queryInterface.sequelize.query(texto, { transaction });
    await sql("SET LOCAL lock_timeout = '5s'");
    await comprobar(queryInterface, transaction);
    const ahora = queryInterface.sequelize.literal("now()");

    // 1. Names: 41 cities carried stray spaces, which is how «Ventillas » hid.
    await sql(`UPDATE ciudads SET name = ${limpio} WHERE name IS DISTINCT FROM ${limpio}`);

    // 2. The merge. The loser is archived, not deleted: it is the record of
    //    what was merged, and nothing points at it afterwards.
    for (const { pierde, gana } of FUSIONES) {
      await sql(`UPDATE postes SET "id_ciudadA" = ${gana} WHERE "id_ciudadA" = ${pierde}`);
      await sql(`UPDATE postes SET "id_ciudadB" = ${gana} WHERE "id_ciudadB" = ${pierde}`);
      await sql(`UPDATE ciudads SET "deletedAt" = now() WHERE id = ${pierde} AND "deletedAt" IS NULL`);
    }

    // 3. Departments.
    await queryInterface.createTable("departamentos", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    }, { transaction });
    await queryInterface.bulkInsert("departamentos", DEPARTAMENTOS.map((name) => ({ name })), { transaction });

    // 4. Tramos.
    await queryInterface.createTable("tramos", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_ciudad_min: {
        type: DataTypes.INTEGER, allowNull: false,
        references: { model: "ciudads", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      },
      id_ciudad_max: {
        type: DataTypes.INTEGER, allowNull: false,
        references: { model: "ciudads", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      },
      id_departamento: {
        type: DataTypes.INTEGER, allowNull: true,
        references: { model: "departamentos", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      },
      id_usuario: {
        type: DataTypes.INTEGER, allowNull: true,
        references: { model: "usuarios", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
      },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await sql(`ALTER TABLE tramos ADD CONSTRAINT ${RESTRICCIONES.orden} CHECK (id_ciudad_min < id_ciudad_max)`);
    // No WHERE: an archived tramo keeps its pair, so the pair cannot be made twice.
    await sql(`CREATE UNIQUE INDEX ${RESTRICCIONES.parUnico} ON tramos (id_ciudad_min, id_ciudad_max)`);

    // From every pole, archived ones included: none may be left without a tramo.
    await sql(
      `INSERT INTO tramos (id_ciudad_min, id_ciudad_max, "createdAt", "updatedAt")
       SELECT DISTINCT LEAST("id_ciudadA", "id_ciudadB"), GREATEST("id_ciudadA", "id_ciudadB"), now(), now()
         FROM postes ORDER BY 1, 2`,
    );

    // 5. Poles point at their tramo.
    await queryInterface.addColumn("postes", "id_tramo", {
      type: DataTypes.INTEGER, allowNull: true,
      references: { model: "tramos", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    }, { transaction });
    await sql(
      `UPDATE postes p SET "id_tramo" = t.id FROM tramos t
        WHERE t.id_ciudad_min = LEAST(p."id_ciudadA", p."id_ciudadB")
          AND t.id_ciudad_max = GREATEST(p."id_ciudadA", p."id_ciudadB")`,
    );

    // 6. Pole by pole, before anything is dropped. The report totals cannot be
    //    this check — they already merged both directions — so it is made here,
    //    while the two columns still exist to compare against.
    const [{ n }] = await queryInterface.sequelize.query<{ n: string }>(
      `/* comprobacion */ SELECT count(*) AS n FROM postes p
         LEFT JOIN tramos t ON t.id = p."id_tramo"
        WHERE t.id IS NULL
           OR t.id_ciudad_min <> LEAST(p."id_ciudadA", p."id_ciudadB")
           OR t.id_ciudad_max <> GREATEST(p."id_ciudadA", p."id_ciudadB")`,
      { type: QueryTypes.SELECT, transaction },
    );
    if (Number(n) !== 0) {
      throw new Error(`${n} postes no coinciden con el tramo que se les ha asignado. La migración se deshace entera.`);
    }
    await sql(`ALTER TABLE postes ALTER COLUMN "id_tramo" SET NOT NULL`);
    await sql(`CREATE INDEX idx_postes_tramo ON postes ("id_tramo")`);

    // 7. The two columns. Their foreign keys go with them.
    await sql("DROP INDEX IF EXISTS idx_postes_ciudada");
    await sql("DROP INDEX IF EXISTS idx_postes_ciudadb");
    await queryInterface.removeColumn("postes", "id_ciudadA", { transaction });
    await queryInterface.removeColumn("postes", "id_ciudadB", { transaction });
  });
}

/**
 * Rebuilds the two columns from the tramo. It does not restore the direction
 * each pole had, nor the cities that were merged, nor the spaces in the names:
 * see the head of this file.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const sql = (texto: string) => queryInterface.sequelize.query(texto, { transaction });
    await sql("SET LOCAL lock_timeout = '5s'");

    for (const columna of ["id_ciudadA", "id_ciudadB"]) {
      await queryInterface.addColumn("postes", columna, {
        type: DataTypes.INTEGER, allowNull: true,
        references: { model: "ciudads", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
      }, { transaction });
    }
    await sql(
      `UPDATE postes p SET "id_ciudadA" = t.id_ciudad_min, "id_ciudadB" = t.id_ciudad_max
         FROM tramos t WHERE t.id = p."id_tramo"`,
    );
    await sql(`ALTER TABLE postes ALTER COLUMN "id_ciudadA" SET NOT NULL`);
    await sql(`ALTER TABLE postes ALTER COLUMN "id_ciudadB" SET NOT NULL`);
    // Unquoted on purpose: that is how they were created, so that is their name.
    await sql(`CREATE INDEX idx_postes_ciudada ON postes ("id_ciudadA")`);
    await sql(`CREATE INDEX idx_postes_ciudadb ON postes ("id_ciudadB")`);

    await sql("DROP INDEX IF EXISTS idx_postes_tramo");
    await queryInterface.removeColumn("postes", "id_tramo", { transaction });
    await queryInterface.dropTable("tramos", { transaction });
    await queryInterface.dropTable("departamentos", { transaction });
  });
}
