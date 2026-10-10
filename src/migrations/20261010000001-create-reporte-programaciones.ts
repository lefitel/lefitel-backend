import { QueryInterface, DataTypes } from "sequelize";

/**
 * Scheduled reports: a saved report sent by email every day, week or month.
 * Design: docs/specs/2026-10-10-informes-programados-design.md.
 *
 * Three tables.
 *
 * `reporte_programaciones` — the schedule: which saved report, whose it is,
 * how often, in what format, and when it next runs.
 *
 * `reporte_programacion_destinatarios` — who receives it. A row is a user of
 * the system **or** an outside address, never both and never neither; the
 * CHECK says so, because the two are treated differently everywhere that
 * matters (an outside address never receives staff data, and gets an
 * unsubscribe link).
 *
 * `reporte_ejecuciones` — one row per run that was due. **Its unique key on
 * `(id_programacion, programada_para)` is the lock.** The scheduler claims a
 * run by inserting this row; if the process restarted mid-send, or there is
 * one day a second container, the second insert collides and nothing is sent
 * twice. That is why this is a table and not a line in the bitácora.
 *
 * CHECK constraints rather than ENUM types, like `sesiones.mfa_source`: an
 * ENUM is a type of its own that every later change has to alter and every
 * rollback has to remember to drop.
 *
 * `dia_mes` stops at 28 so that the day exists in every month. `dia_semana`
 * is ISO: 1 is Monday.
 */

const PROGRAMACIONES = "reporte_programaciones";
const DESTINATARIOS = "reporte_programacion_destinatarios";
const EJECUCIONES = "reporte_ejecuciones";

export const FRECUENCIAS = ["diaria", "semanal", "mensual"] as const;
// The exporter's own names for its two formats (`ExportFormat`).
export const FORMATOS = ["excel", "pdf"] as const;
export const ESTADOS_DE_EJECUCION = [
  "en_curso",
  "enviado",
  "vacio",
  "demasiado_grande",
  "fallido",
  "omitido",
] as const;

const lista = (valores: readonly string[]) => valores.map((v) => `'${v}'`).join(", ");

/** Every CHECK this migration adds, by table. Exported for the test. */
export const RESTRICCIONES: Record<string, Record<string, string>> = {
  [PROGRAMACIONES]: {
    reporte_programaciones_frecuencia_chk: `frecuencia IN (${lista(FRECUENCIAS)})`,
    reporte_programaciones_formato_chk: `formato IN (${lista(FORMATOS)})`,
    reporte_programaciones_hora_chk: "hora BETWEEN 0 AND 23",
    reporte_programaciones_dia_semana_chk: "dia_semana IS NULL OR dia_semana BETWEEN 1 AND 7",
    reporte_programaciones_dia_mes_chk: "dia_mes IS NULL OR dia_mes BETWEEN 1 AND 28",
    // The day belongs to its frequency and to no other: a weekly schedule
    // has a weekday and no day of the month, and so on round.
    reporte_programaciones_dia_chk:
      "(frecuencia = 'semanal') = (dia_semana IS NOT NULL) AND (frecuencia = 'mensual') = (dia_mes IS NOT NULL)",
    // A paused schedule has no next run, and an active one always does —
    // otherwise the scheduler's query would never find it and nothing would say so.
    reporte_programaciones_proxima_chk: "activa = (proxima_ejecucion IS NOT NULL)",
  },
  [DESTINATARIOS]: {
    reporte_destinatarios_uno_chk: "(id_usuario IS NULL) <> (email IS NULL)",
    reporte_destinatarios_email_chk: "email IS NULL OR email = lower(btrim(email))",
  },
  [EJECUCIONES]: {
    reporte_ejecuciones_estado_chk: `estado IN (${lista(ESTADOS_DE_EJECUCION)})`,
  },
};

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Same house rule as every other migration here: fail fast on a lock
    // instead of queuing behind whatever else holds `usuarios`.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    const ahora = queryInterface.sequelize.literal("now()");

    await queryInterface.createTable(
      PROGRAMACIONES,
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_reporte: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: "reporte_vistas", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        id_usuario: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        frecuencia: { type: DataTypes.STRING(10), allowNull: false },
        dia_semana: { type: DataTypes.SMALLINT, allowNull: true },
        dia_mes: { type: DataTypes.SMALLINT, allowNull: true },
        hora: { type: DataTypes.SMALLINT, allowNull: false },
        formato: { type: DataTypes.STRING(5), allowNull: false },
        con_fotos: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        activa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        motivo_pausa: { type: DataTypes.STRING(40), allowNull: true },
        fallos_seguidos: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
        proxima_ejecucion: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
        deleted_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.createTable(
      DESTINATARIOS,
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_programacion: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: PROGRAMACIONES, key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        id_usuario: {
          type: DataTypes.INTEGER,
          allowNull: true,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        email: { type: DataTypes.STRING(255), allowNull: true },
        rechazos_seguidos: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
        baja_at: { type: DataTypes.DATE, allowNull: true },
        // SHA-256 of the unsubscribe token, in hex. The token itself only
        // ever exists in the link that was mailed.
        baja_token_hash: { type: DataTypes.STRING(64), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
      },
      { transaction },
    );

    await queryInterface.createTable(
      EJECUCIONES,
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_programacion: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: PROGRAMACIONES, key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        programada_para: { type: DataTypes.DATE, allowNull: false },
        manual: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "en_curso" },
        iniciada_at: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
        terminada_at: { type: DataTypes.DATE, allowNull: true },
        filas: { type: DataTypes.INTEGER, allowNull: true },
        bytes: { type: DataTypes.INTEGER, allowNull: true },
        enviados: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
        no_enviados: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
        detalle: { type: DataTypes.STRING(300), allowNull: true },
      },
      { transaction },
    );

    for (const [tabla, restricciones] of Object.entries(RESTRICCIONES)) {
      for (const [nombre, condicion] of Object.entries(restricciones)) {
        await queryInterface.sequelize.query(
          `ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre} CHECK (${condicion})`,
          { transaction },
        );
      }
    }

    // What the scheduler asks every minute: "which active schedules are due?"
    await queryInterface.sequelize.query(
      `CREATE INDEX ${PROGRAMACIONES}_pendientes_idx ON ${PROGRAMACIONES} (proxima_ejecucion)
         WHERE activa AND deleted_at IS NULL`,
      { transaction },
    );
    await queryInterface.addIndex(PROGRAMACIONES, {
      fields: ["id_reporte"],
      name: `${PROGRAMACIONES}_reporte_idx`,
      transaction,
    });
    await queryInterface.addIndex(PROGRAMACIONES, {
      fields: ["id_usuario"],
      name: `${PROGRAMACIONES}_usuario_idx`,
      transaction,
    });

    // Nobody is on the same schedule twice, by either way of being on it.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX reporte_destinatarios_usuario_uq ON ${DESTINATARIOS} (id_programacion, id_usuario)
         WHERE id_usuario IS NOT NULL`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX reporte_destinatarios_email_uq ON ${DESTINATARIOS} (id_programacion, email)
         WHERE email IS NOT NULL`,
      { transaction },
    );
    // The unsubscribe link is looked up by this and nothing else.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX reporte_destinatarios_baja_uq ON ${DESTINATARIOS} (baja_token_hash)
         WHERE baja_token_hash IS NOT NULL`,
      { transaction },
    );
    await queryInterface.addIndex(DESTINATARIOS, {
      fields: ["id_usuario"],
      name: "reporte_destinatarios_usuario_idx",
      transaction,
    });

    // The lock described in the header, and the history's sort order.
    await queryInterface.addIndex(EJECUCIONES, {
      fields: ["id_programacion", "programada_para"],
      unique: true,
      name: "reporte_ejecuciones_turno_uq",
      transaction,
    });
  });
}

/**
 * Drops the three tables, children first. Whatever schedules and history they
 * held go with them: nothing else in the schema refers to these tables, so
 * the rollback leaves the database exactly as it was before `up`.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable(EJECUCIONES, { transaction });
    await queryInterface.dropTable(DESTINATARIOS, { transaction });
    await queryInterface.dropTable(PROGRAMACIONES, { transaction });
  });
}
