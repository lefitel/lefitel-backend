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
    // Trimmed and normalised to lowercase here, and only here, so every write
    // path — `/auth/email/send`, an admin screen, a seed script, whatever
    // comes next — stores the same value without each one remembering to
    // call a helper first. Reads are deliberately left untouched: what this
    // stored is what a lookup compares against. `usuarios_email_verificado_uniq`
    // also applies `lower()` in the migration, but that is a second line of
    // defence against a row written by raw SQL, not the primary one — the
    // primary one is here, at the one place every ORM write goes through.
    //
    // The trim is not cosmetic — deleting it is a real bug, silently. Without
    // it, " isaias@x.com " and "isaias@x.com" are different strings to both
    // Postgres and Node, so (1) the partial unique index stops doing its job
    // — two accounts can "verify" what is really the same mailbox, one with
    // padding and one without — and (2) whoever typed their address without
    // the stray space later, e.g. into `/auth/password/forgot`, gets no match
    // on `lower(email) = lower($1)`. That endpoint answers identically
    // whether the account exists or not, on purpose, so there is no error
    // message anywhere to point at the padding: the reset link just never
    // arrives, for a reason nobody can see from outside. Same class of bug as
    // the password comparison this codebase already fixed by trimming before
    // measuring — here it is trim before storing.
    set(this: Model, value: unknown) {
      this.setDataValue("email", typeof value === "string" ? value.trim().toLowerCase() : value);
    },
  },
  email_verified_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  mfa_grace_until: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // NOT NULL with no value ever supplied by `createUsuario` — `creatableFrom`
  // never picks it. The column has a `now()` default in the migration, but
  // Sequelize's own `notNull` validation runs before any SQL is sent and
  // knows nothing about a DB-level default, so without this the same
  // `.create(...)` call that works today would throw on every new account.
  pass_changed_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
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
