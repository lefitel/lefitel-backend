import { QueryInterface, DataTypes } from "sequelize";

// Saved configurations for the dynamic report builder.
// Table name is set explicitly: Sequelize's pluralisation has already produced
// surprises in this schema (`ciudads`, `rols`, `revicions`).

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  // One transaction for the whole migration. Postgres supports transactional
  // DDL, and without it a failure on a later index would leave the table
  // created but unrecorded in SequelizeMeta: the next deploy re-runs `up`, hits
  // "relation already exists" and crash-loops until someone intervenes by hand.
  await queryInterface.sequelize.transaction(async (transaction) => {
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
    }, { transaction });

    // Listing always filters by owner or by shared visibility.
    await queryInterface.addIndex("reporte_vistas", ["id_usuario"], {
      name: "idx_reporte_vistas_usuario",
      transaction,
    });
    await queryInterface.addIndex("reporte_vistas", ["visibility"], {
      name: "idx_reporte_vistas_visibility",
      transaction,
    });
    await queryInterface.addIndex("reporte_vistas", ["deletedAt"], {
      name: "idx_reporte_vistas_deleted",
      transaction,
    });

    // `evento.solucion` compiles to a LATERAL keyed on id_evento, and solucions
    // carried only its primary key: 1376 sequential scans over 1071 rows for a
    // single column. ARCHITECTURE.md documents the same index for revicions and
    // eventoObs; this one was missed.
    await queryInterface.addIndex("solucions", ["id_evento"], {
      name: "idx_solucions_id_evento",
      transaction,
    });
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeIndex("solucions", "idx_solucions_id_evento", { transaction });
    await queryInterface.dropTable("reporte_vistas", { transaction });
    // dropTable only cleans up the enum when a model is registered for that
    // table, and the migrator loads no models, so drop the type explicitly.
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_reporte_vistas_visibility";',
      { transaction },
    );
  });
}
