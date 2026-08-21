import { QueryInterface, DataTypes, QueryTypes } from "sequelize";

/**
 * Moves the permission matrix out of the browser and into the database.
 *
 * Until now the only description of what each role may do lived in
 * `web/src/lib/permissions.ts` — that is, on the user's machine, where it is a
 * suggestion rather than a rule. The server never asked. This table is where
 * that matrix goes so the server can enforce it and an administrator can change
 * it without a deploy.
 *
 * One row per cell: role × module × action → allowed. Ten modules and four
 * actions make 40 rows per role. Small enough to read whole and keep in memory,
 * and one row per checkbox means the audit log can name exactly what changed.
 *
 * The seed below is a frozen snapshot of the matrix as it stood on 18 August
 * 2026, copied by hand rather than imported: a migration must keep doing what it
 * did the day it ran, and importing a constant would let a later edit rewrite
 * history. Applying this changes nobody's permissions.
 */

const MODULES = [
  "postes",
  "eventos",
  "ciudades",
  "parametros",
  "reportes",
  "generador",
  "seguridad",
  "roles",
  "archivos",
  "bitacora",
] as const;

const ACTIONS = ["ver", "crear", "editar", "archivar"] as const;

type Cell = Record<(typeof ACTIONS)[number], boolean>;

const TODO: Cell = { ver: true, crear: true, editar: true, archivar: true };
const EDICION: Cell = { ver: true, crear: true, editar: true, archivar: false };
const LECTURA: Cell = { ver: true, crear: false, editar: false, archivar: false };
const NADA: Cell = { ver: false, crear: false, editar: false, archivar: false };

/**
 * What the three roles could do the day this ran.
 *
 * Roles 1-3 come straight from the frontend matrix, plus two modules it did not
 * name. `generador` gated itself in the router with `requireRole(1, 2, 3)`, so
 * all three roles get it whole — that is what the line meant. `roles` is new and
 * belongs to administration alone: it is the authority to hand out authority,
 * which is why it is not folded into `seguridad`. Somebody who may edit user
 * accounts should not thereby be able to make themselves an administrator.
 */
const SNAPSHOT: Record<number, Record<(typeof MODULES)[number], Cell>> = {
  // Administrador
  1: {
    postes: TODO,
    eventos: TODO,
    ciudades: TODO,
    parametros: TODO,
    reportes: TODO,
    generador: TODO,
    seguridad: TODO,
    roles: TODO,
    archivos: TODO,
    bitacora: TODO,
  },
  // Coordinador: crea y edita el trabajo de campo, no archiva nada.
  2: {
    postes: EDICION,
    eventos: EDICION,
    ciudades: EDICION,
    parametros: EDICION,
    reportes: LECTURA,
    generador: TODO,
    seguridad: NADA,
    roles: NADA,
    archivos: NADA,
    bitacora: NADA,
  },
  // Cliente: mira, y usa el generador de reportes.
  3: {
    postes: LECTURA,
    eventos: LECTURA,
    ciudades: LECTURA,
    parametros: NADA,
    reportes: LECTURA,
    generador: TODO,
    seguridad: NADA,
    roles: NADA,
    archivos: NADA,
    bitacora: NADA,
  },
};

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.createTable("permisos", {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    id_rol: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "rols", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    modulo: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    accion: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    permitido: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  // One cell cannot be two answers at once, and the lookup is always by all
  // three columns.
  await queryInterface.addIndex("permisos", ["id_rol", "modulo", "accion"], {
    unique: true,
    name: "permisos_rol_modulo_accion_uq",
  });

  const roles = await queryInterface.sequelize.query<{ id: number }>(
    'SELECT id FROM "rols" ORDER BY id',
    { type: QueryTypes.SELECT },
  );

  const now = new Date();
  const rows: Record<string, unknown>[] = [];
  for (const { id } of roles) {
    for (const modulo of MODULES) {
      for (const accion of ACTIONS) {
        rows.push({
          id_rol: id,
          modulo,
          accion,
          // A role this snapshot does not know about starts with nothing. It is
          // the safe direction to be wrong in, and an administrator can grant
          // from the Seguridad screen.
          permitido: SNAPSHOT[id]?.[modulo]?.[accion] ?? false,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (rows.length > 0) await queryInterface.bulkInsert("permisos", rows);
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.removeIndex("permisos", "permisos_rol_modulo_accion_uq");
  await queryInterface.dropTable("permisos");
}
