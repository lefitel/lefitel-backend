import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CiudadModel } from "./ciudad.model.js";
import { DepartamentoModel } from "./departamento.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { ITramo } from "../interfaces/index.js";

type TramoCreation = Optional<ITramo, "id">;

/**
 * A stretch of line between two cities, with no direction.
 *
 * `id_ciudad_min` and `id_ciudad_max` are not a start and an end. They are the
 * two ends, told apart by the only thing that can tell them apart without
 * inventing an order: which id is lower. That rule is what makes a pair exist
 * once — (3,7) and (7,3) are the same row — and the database holds it with a
 * CHECK and a unique index (`20261010000005-create-tramos.ts`). The validator
 * below is the same rule one step earlier, so a controller that forgets to
 * normalise gets a sentence instead of SQLSTATE 23514, which `handler.ts` does
 * not translate.
 *
 * The two names never leave this layer: what travels is `ciudades`, built by
 * `tramos/presentacion.ts`.
 */
export const TramoModel: ModelDefined<ITramo, TramoCreation> = sequelize.define("tramo", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  id_ciudad_min: { type: DataTypes.INTEGER, allowNull: false },
  id_ciudad_max: { type: DataTypes.INTEGER, allowNull: false },
  id_departamento: { type: DataTypes.INTEGER, allowNull: true },
  id_usuario: { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName: "tramos",
  paranoid: true,
  validate: {
    // Only when both ends are there. A static update (`restore`, `update(values,
    // { where })`) validates an instance holding just the values being written,
    // so both ends are `undefined` and there is no pair to judge; on create their
    // absence is already refused by `allowNull: false`.
    extremosEnOrden(this: { id_ciudad_min?: number; id_ciudad_max?: number }) {
      if (this.id_ciudad_min == null || this.id_ciudad_max == null) return;
      if (!(Number(this.id_ciudad_min) < Number(this.id_ciudad_max))) {
        throw new Error("id_ciudad_min must be lower than id_ciudad_max");
      }
    },
  },
});

/**
 * The columns of a tramo that may travel inside somebody else's response.
 *
 * `id_usuario` is the one left out, for the reason `POSTE_PUBLIC_ATTRIBUTES`
 * gives: a bare include ships the whole row, and the author of a record is
 * shown behind `seguridad.ver` and nowhere else. `deletedAt` is in because the
 * presenter turns it into `archivado`.
 */
export const TRAMO_PUBLIC_ATTRIBUTES = [
  "id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt",
] as const;

CiudadModel.hasMany(TramoModel, { foreignKey: "id_ciudad_min", as: "tramosMin" });
TramoModel.belongsTo(CiudadModel, { foreignKey: "id_ciudad_min", as: "ciudadMin" });

CiudadModel.hasMany(TramoModel, { foreignKey: "id_ciudad_max", as: "tramosMax" });
TramoModel.belongsTo(CiudadModel, { foreignKey: "id_ciudad_max", as: "ciudadMax" });

DepartamentoModel.hasMany(TramoModel, { foreignKey: "id_departamento" });
TramoModel.belongsTo(DepartamentoModel, { foreignKey: "id_departamento" });

UsuarioModel.hasMany(TramoModel, { foreignKey: "id_usuario" });
TramoModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
