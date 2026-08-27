import { QueryInterface, Op } from "sequelize";

// Removes the permission cells that no module has any more.
//
// The matrix used to be a strict grid — ten modules by four actions — and every
// module carried all four verbs whether it used them or not. `matrix.ts` now has
// each module declare its own actions, which leaves eight combinations with rows
// in this table and nowhere in the code that reads them: `archivos` never had a
// `crear` or an `editar`, and `reportes` and `bitacora` only ever answer `ver`.
//
// They are not merely unused. In production all eight sit at `true` for role 1,
// so the Seguridad screen has been showing the administrator eight ticked boxes
// that grant nothing — and, worse, offering them to be ticked for other roles.
// Left in place they are a permission waiting to happen: the day `archivos`
// gains a `crear` to close `POST /api/upload`, whatever was ticked here starts
// meaning yes, and nobody will remember ticking it.
//
// Two things stop them coming straight back, and both live in the same commit as
// this file. `store.ts` and `permiso.controller.ts` now check the *pair* rather
// than each half, so a request naming `bitacora.archivar` is refused instead of
// written; and `seedRolePermissions` walks each module's own actions, so the
// next role created from the screen does not re-seed all forty.
//
// **The list below is written out literally, and must stay that way.** Importing
// `PERMISSIONS` from `matrix.ts` would make this migration mean something
// different every time that constant changes — replaying the history against a
// restored dump would delete a set of rows nobody chose. A migration records
// what happened on a day. `20260818000001-create-permisos.ts` froze its own
// snapshot for the same reason.

/** The eight pairs no module has, as of 2026-08-27. Frozen on purpose. */
const CELDAS_MUERTAS = [
  { modulo: "archivos", accion: "crear" },
  { modulo: "archivos", accion: "editar" },
  { modulo: "reportes", accion: "crear" },
  { modulo: "reportes", accion: "editar" },
  { modulo: "reportes", accion: "archivar" },
  { modulo: "bitacora", accion: "crear" },
  { modulo: "bitacora", accion: "editar" },
  { modulo: "bitacora", accion: "archivar" },
];

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule for every schema change here. `permisos` holds a hundred
    // and twenty rows and is read through a cache, so this lock is not the one
    // that would hurt — but a migration that fails fast and gets retried beats
    // one that queues every request behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    // Matched pair by pair rather than `modulo IN (...) AND accion IN (...)`,
    // which would also match `archivos.ver` and `bitacora.ver` — two live
    // permissions, and `bitacora.ver` is the only thing standing between the
    // audit log and every account in the system.
    await queryInterface.bulkDelete(
      "permisos",
      { [Op.or]: CELDAS_MUERTAS },
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    const valores = CELDAS_MUERTAS.map((c) => `('${c.modulo}', '${c.accion}')`).join(", ");

    // One statement instead of reading the roles and then writing them: the set
    // of roles is exactly "whoever has rows in this table", and asking for it
    // first would open a window where a role created in between gets no rows.
    //
    // `permitido` is forced to false, and that is the whole point of this
    // direction. Role 1 held all eight at `true` before `up` ran, but no code
    // has ever read these cells, so that `true` records nothing worth restoring
    // — while putting it back would hand an authority to a role during a
    // rollback nobody is watching. Undoing towards "no" is the only direction
    // that cannot surprise anybody.
    //
    // `ON CONFLICT DO NOTHING` because the unique index on
    // (id_rol, modulo, accion) is what makes a re-run of `down` harmless.
    await queryInterface.sequelize.query(
      `INSERT INTO "permisos" ("id_rol", "modulo", "accion", "permitido", "createdAt", "updatedAt")
       SELECT DISTINCT p."id_rol", v.modulo, v.accion, false, NOW(), NOW()
       FROM "permisos" p
       CROSS JOIN (VALUES ${valores}) AS v(modulo, accion)
       ON CONFLICT ("id_rol", "modulo", "accion") DO NOTHING`,
      { transaction },
    );
  });
}
