import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { QueryTypes } from "sequelize";
import { sequelize } from "./sequelize.js";
import { normaliseMigrationNames } from "./migrate.js";

/**
 * Exercised against a scratch table, never the real registry: a mistake here
 * would make umzug replay every migration ever applied.
 */
const TABLE = "SequelizeMetaNormaliseTest";

const dbAvailable = await sequelize
  .authenticate()
  .then(() => true)
  .catch(() => false);

const names = async (): Promise<string[]> => {
  const rows = await sequelize.query<{ name: string }>(
    `SELECT name FROM "${TABLE}" ORDER BY name`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.name);
};

const seed = async (values: string[]) => {
  await sequelize.query(`DELETE FROM "${TABLE}"`);
  for (const value of values) {
    await sequelize.query(`INSERT INTO "${TABLE}" (name) VALUES (:value)`, {
      replacements: { value },
    });
  }
};

describe.skipIf(!dbAvailable)("normaliseMigrationNames", () => {
  beforeAll(async () => {
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS "${TABLE}" (name VARCHAR(255) NOT NULL PRIMARY KEY)`,
    );
  });

  afterAll(async () => {
    await sequelize.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  });

  beforeEach(async () => {
    await sequelize.query(`DELETE FROM "${TABLE}"`);
  });

  it("collapses the pair a single migration left behind in two environments", async () => {
    // Exactly what the real registry held: one local run and one deployed run
    // of the same file, recorded as two separate migrations.
    await seed([
      "20260503000001-add-missing-fields.js",
      "20260503000001-add-missing-fields.ts",
    ]);

    const result = await normaliseMigrationNames(TABLE);

    expect(result).toEqual({ deduplicated: 1, renamed: 1 });
    expect(await names()).toEqual(["20260503000001-add-missing-fields"]);
  });

  it("strips the extension when there is nothing to deduplicate", async () => {
    await seed(["20260804000001-create-reporte-vista.ts"]);

    const result = await normaliseMigrationNames(TABLE);

    expect(result).toEqual({ deduplicated: 0, renamed: 1 });
    expect(await names()).toEqual(["20260804000001-create-reporte-vista"]);
  });

  it("changes nothing on a second pass", async () => {
    await seed(["20260503000001-add-missing-fields.js", "20260503000001-add-missing-fields.ts"]);
    await normaliseMigrationNames(TABLE);

    const second = await normaliseMigrationNames(TABLE);

    expect(second).toEqual({ deduplicated: 0, renamed: 0 });
    expect(await names()).toEqual(["20260503000001-add-missing-fields"]);
  });

  it("leaves names that already carry no extension", async () => {
    await seed(["20260503000001-add-missing-fields", "20260804000001-create-reporte-vista"]);

    const result = await normaliseMigrationNames(TABLE);

    expect(result).toEqual({ deduplicated: 0, renamed: 0 });
    expect(await names()).toHaveLength(2);
  });

  it("reports nothing for a registry that does not exist yet", async () => {
    // A brand new database: umzug creates the table on first run.
    const result = await normaliseMigrationNames("SequelizeMetaDoesNotExist");

    expect(result).toEqual({ deduplicated: 0, renamed: 0 });
  });

  it("does not mistake an extension inside the name for a trailing one", async () => {
    await seed(["20260101000001-rename-file.ts-backup"]);

    const result = await normaliseMigrationNames(TABLE);

    expect(result).toEqual({ deduplicated: 0, renamed: 0 });
    expect(await names()).toEqual(["20260101000001-rename-file.ts-backup"]);
  });
});
