import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IRol } from "../interfaces/index.js";
type RolCreation = Optional<IRol, "id">;
export const RolModel: ModelDefined<IRol, RolCreation> = sequelize.define("rol", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  description: {
    type: DataTypes.STRING,
  },
// Paranoid, and it is the flag that matters most on this model.
//
// `usuarios.id_rol` is ON DELETE CASCADE, and 20260822000001-create-sesion.ts
// records what that costs when it fires: six users and 4.835 revisions through
// seventeen keys. Without this line `RolModel.destroy()` is a real DELETE and
// `DELETE /api/rol/:id` erases the accounts that hold the role along with every
// field inspection they ever recorded — while the audit log writes one line
// saying a role was removed.
//
// With it, the same call writes `deletedAt` and the cascade never runs. The
// column is added by 20260826000001-add-rol-archiving.ts, and the controller
// still refuses to archive a role somebody holds: three parts, and this is the
// one that makes the other two possible.
}, { paranoid: true });
