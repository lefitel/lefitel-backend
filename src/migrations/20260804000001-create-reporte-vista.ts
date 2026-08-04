import { QueryInterface, DataTypes } from "sequelize";

// Saved configurations for the dynamic report builder.
// Table name is set explicitly: Sequelize's pluralisation has already produced
// surprises in this schema (`ciudads`, `rols`, `revicions`).

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.createTable("reporte_vistas", {
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
      references: { model: "usuarios", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
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
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  // Listing always filters by owner or by shared visibility.
  await queryInterface.addIndex("reporte_vistas", ["id_usuario"], {
    name: "idx_reporte_vistas_usuario",
  });
  await queryInterface.addIndex("reporte_vistas", ["visibility"], {
    name: "idx_reporte_vistas_visibility",
  });
  await queryInterface.addIndex("reporte_vistas", ["deletedAt"], {
    name: "idx_reporte_vistas_deleted",
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.dropTable("reporte_vistas");
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_reporte_vistas_visibility";');
}
