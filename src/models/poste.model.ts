import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { PropietarioModel } from "./propietario.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { CiudadModel } from "./ciudad.model.js";
import { MaterialModel } from "./material.model.js";
import { IPoste } from "../interfaces/index.js";
type PosteCreation = Optional<IPoste, "id">;
export const PosteModel: ModelDefined<IPoste, PosteCreation> = sequelize.define("poste", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  image: {
    type: DataTypes.STRING,
  },
  date: {
    type: DataTypes.DATE,
  },
  lat: {
    allowNull: false,
    type: DataTypes.DOUBLE,
  },
  lng: {
    allowNull: false,
    type: DataTypes.DOUBLE,
  },
  id_propietario: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_material: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_ciudadA: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_ciudadB: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_usuario: {
    type: DataTypes.INTEGER,
  },
}, { paranoid: true });

/**
 * The columns of a pole that may travel inside somebody else's response.
 *
 * `id_usuario` is the one left out, and it is the reason this list exists. The
 * column arrived with the authorship backfill, and `responseShape.test.ts`
 * guarded three models against exactly this — a bare `include` shipping a whole
 * row — but poles were not among them, so `GET /evento/:id` and the three fixed
 * reports were handing the author of every pole to any logged-in account, the
 * Cliente role included. Authorship is exposed in the generator, behind
 * `seguridad.ver`; here it is not exposed at all.
 *
 * `image` is out too, for a different reason: no consumer of a nested pole reads
 * it. The one screen that shows a pole's photograph reads it from
 * `GET /poste/:id`, where the pole is the root and this list does not apply.
 *
 * Named rather than inlined at the four call sites because the failure is
 * silent, and because adding a column is what causes it — so the list belongs
 * where whoever adds one will be looking.
 */
export const POSTE_PUBLIC_ATTRIBUTES = [
  "id", "name", "date", "lat", "lng",
  "id_propietario", "id_material", "id_ciudadA", "id_ciudadB",
] as const;

//Relacion con poste
PropietarioModel.hasMany(PosteModel, { foreignKey: "id_propietario" });
PosteModel.belongsTo(PropietarioModel, { foreignKey: "id_propietario" });

MaterialModel.hasMany(PosteModel, { foreignKey: "id_material" });
PosteModel.belongsTo(MaterialModel, { foreignKey: "id_material" });

CiudadModel.hasMany(PosteModel, { foreignKey: "id_ciudadA", as: "ciudadA" });
PosteModel.belongsTo(CiudadModel, { foreignKey: "id_ciudadA", as: "ciudadA" });

CiudadModel.hasMany(PosteModel, { foreignKey: "id_ciudadB", as: "ciudadB" });
PosteModel.belongsTo(CiudadModel, { foreignKey: "id_ciudadB", as: "ciudadB" });

UsuarioModel.hasMany(PosteModel, { foreignKey: "id_usuario" });
PosteModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
