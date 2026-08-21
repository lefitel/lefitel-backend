import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { RolModel } from "./rol.model.js";
import { IPermiso } from "../interfaces/index.js";

type PermisoCreation = Optional<IPermiso, "id">;

/**
 * One row per cell of the permission matrix.
 *
 * Deliberately not `paranoid`: a permission that was revoked should be gone, not
 * hidden. The history of who changed what lives in the bitácora.
 */
export const PermisoModel: ModelDefined<IPermiso, PermisoCreation> = sequelize.define(
  "permiso",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    id_rol: {
      type: DataTypes.INTEGER,
      allowNull: false,
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
  },
  {
    // Spelled out rather than left to Sequelize's pluraliser: the migration
    // created "permisos" and the two must agree.
    tableName: "permisos",
    indexes: [{ unique: true, fields: ["id_rol", "modulo", "accion"], name: "permisos_rol_modulo_accion_uq" }],
  },
);

RolModel.hasMany(PermisoModel, { foreignKey: "id_rol" });
PermisoModel.belongsTo(RolModel, { foreignKey: "id_rol" });
