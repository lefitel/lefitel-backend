import { Umzug, SequelizeStorage } from "umzug";
import { sequelize } from "./sequelize.js";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const migrator = new Umzug({
  migrations: {
    glob: join(__dirname, "../migrations/*.{ts,js}"),
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
});

async function runMigrations() {
  await sequelize.authenticate();
  const applied = await migrator.up();
  if (applied.length === 0) {
    console.log("--> No hay migraciones pendientes <--");
  } else {
    console.log(`--> ${applied.length} migración(es) aplicada(s) <--`);
    applied.forEach((m) => console.log("   ✓", m.name));
  }
  await sequelize.close();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
