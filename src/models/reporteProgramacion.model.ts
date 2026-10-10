// Scheduled reports — the three tables of
// `migrations/20261010000001-create-reporte-programaciones.ts`, in one file
// because none of them means anything without the other two.
// Design: docs/specs/2026-10-10-informes-programados-design.md.
//
// The vocabularies below are written out again here rather than imported from
// the migration: a migration is a record of what ran on a given day and must
// not change when the code does. `reporteProgramacion.model.test.ts` holds the
// two copies together.

import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { ReporteVistaModel } from "./reporteVista.model.js";
import { UsuarioModel } from "./usuario.model.js";
import type {
  IReporteEjecucion,
  IReporteProgramacion,
  IReporteProgramacionDestinatario,
} from "../interfaces/index.js";

export const FRECUENCIAS = ["diaria", "semanal", "mensual"] as const;
/** The exporter's own names for its two formats — `ExportFormat` in `reportBuilder/export`. */
export const FORMATOS_PROGRAMABLES = ["excel", "pdf"] as const;

/**
 * How a run that was due ended.
 *
 * - `en_curso` — claimed and not finished. A row left here by a process that
 *   died is what stops the same run from being sent again.
 * - `enviado` — the file went out to at least one recipient.
 * - `vacio` — the report had no rows; a short notice went out instead.
 * - `demasiado_grande` — the file was over the attachment ceiling; a notice
 *   without it went out instead.
 * - `fallido` — the export failed, or no recipient could be reached.
 * - `omitido` — due while the server was down, and found too late to be worth
 *   sending. Recorded so the gap in the history has a reason.
 */
export const ESTADOS_DE_EJECUCION = [
  "en_curso",
  "enviado",
  "vacio",
  "demasiado_grande",
  "fallido",
  "omitido",
] as const;

/**
 * Why a schedule is not running. `null` on an active one.
 *
 * Kept as words the screen can translate, not sentences: the reason is shown
 * to the owner beside the schedule, and a sentence stored today is a sentence
 * that cannot be reworded tomorrow.
 */
export const MOTIVOS_DE_PAUSA = [
  "manual",
  "fallos",
  "sin_permiso",
  "dueno_inactivo",
  "informe_archivado",
  "sin_destinatarios",
] as const;

type ProgramacionCreation = Optional<
  IReporteProgramacion,
  | "id"
  | "dia_semana"
  | "dia_mes"
  | "minuto"
  | "con_fotos"
  | "activa"
  | "motivo_pausa"
  | "fallos_seguidos"
  | "proxima_ejecucion"
  | "created_at"
  | "updated_at"
  | "deleted_at"
>;

export const ReporteProgramacionModel: ModelDefined<IReporteProgramacion, ProgramacionCreation> =
  sequelize.define(
    "reporteProgramacion",
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_reporte: { type: DataTypes.INTEGER, allowNull: false },
      id_usuario: { type: DataTypes.INTEGER, allowNull: false },
      frecuencia: { type: DataTypes.STRING(10), allowNull: false },
      dia_semana: { type: DataTypes.SMALLINT, allowNull: true },
      dia_mes: { type: DataTypes.SMALLINT, allowNull: true },
      hora: { type: DataTypes.SMALLINT, allowNull: false },
      minuto: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      formato: { type: DataTypes.STRING(5), allowNull: false },
      con_fotos: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      activa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      motivo_pausa: { type: DataTypes.STRING(40), allowNull: true },
      fallos_seguidos: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      proxima_ejecucion: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "reporte_programaciones",
      paranoid: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
      deletedAt: "deleted_at",
    },
  );

type DestinatarioCreation = Optional<
  IReporteProgramacionDestinatario,
  "id" | "id_usuario" | "email" | "rechazos_seguidos" | "baja_at" | "baja_token" | "created_at"
>;

export const ReporteProgramacionDestinatarioModel: ModelDefined<
  IReporteProgramacionDestinatario,
  DestinatarioCreation
> = sequelize.define(
  "reporteProgramacionDestinatario",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    id_programacion: { type: DataTypes.INTEGER, allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: true },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true,
      // Same normalisation `usuarios.email` gets, and the table's CHECK
      // refuses anything else: two spellings of one address would be two
      // recipients, and the unique index would let both in.
      set(this: { setDataValue(k: string, v: unknown): void }, value: unknown) {
        this.setDataValue("email", typeof value === "string" ? value.trim().toLowerCase() : value);
      },
    },
    rechazos_seguidos: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    baja_at: { type: DataTypes.DATE, allowNull: true },
    baja_token: { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    tableName: "reporte_programacion_destinatarios",
    createdAt: "created_at",
    updatedAt: false,
    // Somebody's unsubscribe token has no reader outside the two places
    // that write the link and redeem it; it is asked for by name there. A
    // schedule's owner listing its recipients must not be handed the means
    // to unsubscribe them — or to prove to them that they "asked".
    defaultScope: { attributes: { exclude: ["baja_token"] } },
  },
);

// `defaultScope` covers reads. This covers the instance a `create()` returns,
// which carries every column it was given — the same second net
// `codigoCorreo.model.ts` keeps for its hash.
(ReporteProgramacionDestinatarioModel.prototype as unknown as Record<string, unknown>).toJSON = function (
  this: { get(): Record<string, unknown> },
) {
  const valores = { ...this.get() };
  delete valores.baja_token;
  return valores;
};

type EjecucionCreation = Optional<
  IReporteEjecucion,
  | "id"
  | "manual"
  | "estado"
  | "iniciada_at"
  | "terminada_at"
  | "filas"
  | "bytes"
  | "enviados"
  | "no_enviados"
  | "detalle"
>;

export const ReporteEjecucionModel: ModelDefined<IReporteEjecucion, EjecucionCreation> = sequelize.define(
  "reporteEjecucion",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    id_programacion: { type: DataTypes.INTEGER, allowNull: false },
    programada_para: { type: DataTypes.DATE, allowNull: false },
    manual: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "en_curso" },
    iniciada_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    terminada_at: { type: DataTypes.DATE, allowNull: true },
    filas: { type: DataTypes.INTEGER, allowNull: true },
    bytes: { type: DataTypes.INTEGER, allowNull: true },
    enviados: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    no_enviados: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    detalle: { type: DataTypes.STRING(300), allowNull: true },
  },
  { tableName: "reporte_ejecuciones", timestamps: false },
);

ReporteVistaModel.hasMany(ReporteProgramacionModel, { foreignKey: "id_reporte" });
ReporteProgramacionModel.belongsTo(ReporteVistaModel, { foreignKey: "id_reporte" });

UsuarioModel.hasMany(ReporteProgramacionModel, { foreignKey: "id_usuario" });
ReporteProgramacionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });

ReporteProgramacionModel.hasMany(ReporteProgramacionDestinatarioModel, {
  foreignKey: "id_programacion",
  as: "destinatarios",
});
ReporteProgramacionDestinatarioModel.belongsTo(ReporteProgramacionModel, { foreignKey: "id_programacion" });

UsuarioModel.hasMany(ReporteProgramacionDestinatarioModel, { foreignKey: "id_usuario" });
ReporteProgramacionDestinatarioModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });

ReporteProgramacionModel.hasMany(ReporteEjecucionModel, { foreignKey: "id_programacion", as: "ejecuciones" });
ReporteEjecucionModel.belongsTo(ReporteProgramacionModel, { foreignKey: "id_programacion" });
