import { QueryInterface, DataTypes } from "sequelize";

/**
 * Who each scheduled run was sent to, and what became of each of them.
 * Design: docs/specs/2026-10-10-informes-programados-design.md, §3.9
 * «Historial global y a quién se envió cada vez».
 *
 * `reporte_ejecuciones` says how a run went as a whole — "enviado, 2 de 3" —
 * and nothing about the three. This is one row per recipient the run wrote to
 * (or would have, had the day's ceiling not stopped it), written as each send
 * finishes. **It exists only for runs after this migration**: nothing is
 * invented for the ones before it, and the screen says so.
 *
 * **A row is a copy, not a reference.** `nombre` is what the recipient was
 * called on screen at that moment — an account's name and surname, an outside
 * address's address — and `correo` is the outside address as it was. The
 * recipient row on the schedule can be edited or removed the next day, and the
 * account renamed or removed; the history must still read as it did.
 *
 * **Account or outside address is decided by `tipo`, not by which column is
 * empty.** The obvious rule — exactly one of `id_usuario` and `correo` — is the
 * one `reporte_programacion_destinatarios` uses, and it breaks here:
 * `id_usuario` is `ON DELETE SET NULL` (the row must outlive the account), and
 * Postgres checks the CHECK on the row that SET NULL rewrites. An account's row
 * would then have neither column set and the deletion of the user would fail.
 * So `tipo` is written once and never changes, and the CHECK reads that:
 * an outside address has its `correo` and no `id_usuario`; an account has no
 * `correo`, and its `id_usuario` is there until the account is removed.
 * (Removing an account is rare — they are archived — but the schema must not
 * be what forbids it.) An account's address is never stored here at all.
 *
 * `ON DELETE CASCADE` on the execution: a run given back before anything was
 * sent (the exporter was taken) is deleted by `liberar`, and the rows go with
 * it. Nothing was sent, so none were written; if one had been, it would be
 * wrong to keep it.
 *
 * CHECK constraints rather than ENUM types, like the siblings.
 */

const TABLA = "reporte_ejecucion_entregas";
const EJECUCIONES = "reporte_ejecuciones";

export const TIPOS_DE_DESTINATARIO = ["usuario", "externo"] as const;
/** See `ResultadoDeEntrega` in `reportSchedule/run.ts` for what each one means. */
export const RESULTADOS_DE_ENTREGA = ["entregado", "rechazado", "no_enviado", "sin_cupo"] as const;

const lista = (valores: readonly string[]) => valores.map((v) => `'${v}'`).join(", ");

/** Every CHECK this migration adds. Exported for the test. */
export const RESTRICCIONES: Record<string, string> = {
  reporte_entregas_tipo_chk: `tipo IN (${lista(TIPOS_DE_DESTINATARIO)})`,
  reporte_entregas_resultado_chk: `resultado IN (${lista(RESULTADOS_DE_ENTREGA)})`,
  reporte_entregas_destino_chk: "(tipo = 'externo') = (correo IS NOT NULL) AND (tipo = 'usuario' OR id_usuario IS NULL)",
};

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      TABLA,
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_ejecucion: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: EJECUCIONES, key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        tipo: { type: DataTypes.STRING(10), allowNull: false },
        id_usuario: {
          type: DataTypes.INTEGER,
          allowNull: true,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL",
        },
        correo: { type: DataTypes.STRING(255), allowNull: true },
        nombre: { type: DataTypes.STRING(255), allowNull: false },
        resultado: { type: DataTypes.STRING(12), allowNull: false },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: queryInterface.sequelize.literal("now()"),
        },
      },
      { transaction },
    );

    for (const [nombre, condicion] of Object.entries(RESTRICCIONES)) {
      await queryInterface.sequelize.query(`ALTER TABLE ${TABLA} ADD CONSTRAINT ${nombre} CHECK (${condicion})`, {
        transaction,
      });
    }

    // Every read asks "the recipients of this run", or "which of these runs have any".
    await queryInterface.addIndex(TABLA, {
      fields: ["id_ejecucion"],
      name: `${TABLA}_ejecucion_idx`,
      transaction,
    });
  });
}

/** Drops the table. Nothing else refers to it, so the schema is as it was before `up`. */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable(TABLA, { transaction });
  });
}
