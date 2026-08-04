import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { IReporteVista } from "../interfaces/index.js";

type ReporteVistaCreation = Optional<
  IReporteVista,
  "id" | "description" | "visibility" | "favorite"
>;

export const ReporteVistaModel: ModelDefined<IReporteVista, ReporteVistaCreation> =
  sequelize.define(
    "reporteVista",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      config: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      id_usuario: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      visibility: {
        type: DataTypes.ENUM("private", "shared"),
        allowNull: false,
        defaultValue: "private",
      },
      favorite: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    // Explicit table name: Sequelize's pluralisation is unreliable in this schema.
    { tableName: "reporte_vistas", paranoid: true },
  );

UsuarioModel.hasMany(ReporteVistaModel, { foreignKey: "id_usuario" });
ReporteVistaModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
