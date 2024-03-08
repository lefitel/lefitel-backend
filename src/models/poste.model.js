import { DataTypes } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { PropietarioModel } from "./propietario.model.js";
import { AdssModel } from "./adss.model.js";
import { CiudadModel } from "./ciudad.model.js";
import { MaterialModel } from "./material.model.js";
/*import { MaterialModel } from "./material.model.js";
import { PropietarioModel } from "./propietario.model.js";
import { CiudadModel } from "./ciudad.model.js";*/

export const PosteModel = sequelize.define("poste", {
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
});

//Relacion con poste
PropietarioModel.hasMany(PosteModel, { foreignKey: "id_propietario" });
PosteModel.belongsTo(PropietarioModel, { foreignKey: "id_propietario" });

MaterialModel.hasMany(PosteModel, { foreignKey: "id_material" });
PosteModel.belongsTo(MaterialModel, { foreignKey: "id_material" });

CiudadModel.hasMany(PosteModel, { foreignKey: "id_ciudadA", as: "ciudadA" });
PosteModel.belongsTo(CiudadModel, { foreignKey: "id_ciudadA", as: "ciudadA" });

CiudadModel.hasMany(PosteModel, { foreignKey: "id_ciudadB", as: "ciudadB" });
PosteModel.belongsTo(CiudadModel, { foreignKey: "id_ciudadB", as: "ciudadB" });
