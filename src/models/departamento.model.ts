import { DataTypes, ModelDefined } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IDepartamento } from "../interfaces/index.js";

/**
 * The nine departments of Bolivia, in the order the migration seeds them.
 *
 * A table and not a constant because the report generator and the exporters
 * work in SQL, where a name has to be something a query can join to. It has no
 * screen and no write route: the list does not change, and the day it does is
 * a line in a migration.
 */
export const DEPARTAMENTOS = [
  "Chuquisaca", "La Paz", "Cochabamba", "Oruro", "Potosí", "Tarija", "Santa Cruz", "Beni", "Pando",
] as const;

export const DepartamentoModel: ModelDefined<IDepartamento, IDepartamento> = sequelize.define("departamento", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
}, { tableName: "departamentos", timestamps: false });
