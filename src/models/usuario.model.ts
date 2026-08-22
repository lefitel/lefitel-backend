import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { RolModel } from "./rol.model.js";
import { IUsuario } from "../interfaces/index.js";
type UsuarioCreation = Optional<IUsuario, "id">;
export const UsuarioModel: ModelDefined<IUsuario, UsuarioCreation> = sequelize.define("usuario", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  lastname: {
    type: DataTypes.STRING,
  },
  birthday: {
    type: DataTypes.DATE,
  },
  image: {
    type: DataTypes.STRING,
  },
  phone: {
    type: DataTypes.STRING,
  },
  user: {
    type: DataTypes.STRING,
  },
  pass: {
    type: DataTypes.STRING,
  },
  id_rol: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  failed_attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  locked_until: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, { paranoid: true });

RolModel.hasMany(UsuarioModel, {
  foreignKey: "id_rol",
});
UsuarioModel.belongsTo(RolModel, {
  foreignKey: "id_rol",
});

/**
 * The author of something, as a REST response may name them.
 *
 * `include: [{ model: UsuarioModel }]` with no `attributes` sends every column
 * of this table, and one of them is `pass`. `GET /evento/:id` and
 * `GET /poste/:id` did exactly that on routes gated only by "be logged in", so
 * any account — the Cliente role included — could read the bcrypt hash of
 * whoever registered an event, plus their phone, their login name and their
 * failed-attempt counter. The catalog states one file away that `pass` never
 * appears in a report; this made that true of reports only.
 *
 * Three names is what an author needs to be shown as an author. Anything more
 * belongs to the screen that administers accounts, behind `seguridad.ver`.
 */
export const USUARIO_AS_AUTHOR = ["id", "name", "lastname"] as const;
