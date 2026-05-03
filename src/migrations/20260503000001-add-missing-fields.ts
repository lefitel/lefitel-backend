import { QueryInterface, DataTypes } from "sequelize";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.addColumn("obs", "criticality", {
    type: DataTypes.INTEGER,
    allowNull: true,
  });

  await queryInterface.addColumn("bitacoras", "metadata", {
    type: DataTypes.JSONB,
    allowNull: true,
  });

  await queryInterface.addColumn("bitacoras", "severity", {
    type: DataTypes.ENUM("info", "warning", "critical"),
    allowNull: false,
    defaultValue: "info",
  });

  await queryInterface.addColumn("bitacoras", "ip_address", {
    type: DataTypes.STRING(45),
    allowNull: true,
  });

  await queryInterface.changeColumn("bitacoras", "detail", {
    type: DataTypes.STRING(500),
    allowNull: true,
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.removeColumn("obs", "criticality");
  await queryInterface.removeColumn("bitacoras", "metadata");
  await queryInterface.removeColumn("bitacoras", "severity");
  await queryInterface.removeColumn("bitacoras", "ip_address");
  await queryInterface.changeColumn("bitacoras", "detail", {
    type: DataTypes.STRING(255),
    allowNull: true,
  });
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_bitacoras_severity";');
}
