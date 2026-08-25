import { DataTypes, Model, ModelDefined, Optional } from "sequelize";
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
  email: {
    type: DataTypes.STRING(255),
    allowNull: true,
    // Normalised to lowercase here, and only here, so every write path —
    // `/auth/email/send`, an admin screen, a seed script, whatever comes
    // next — stores the same casing without each one remembering to call a
    // helper first. Reads are deliberately left untouched: what this stored
    // is what a lookup compares against. `usuarios_email_verificado_uniq`
    // also applies `lower()` in the migration, but that is a second line of
    // defence against a row written by raw SQL, not the primary one — the
    // primary one is here, at the one place every ORM write goes through.
    set(this: Model, value: unknown) {
      this.setDataValue("email", typeof value === "string" ? value.toLowerCase() : value);
    },
  },
  email_verified_at: {
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
