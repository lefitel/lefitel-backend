import { Umzug, SequelizeStorage } from "umzug";
import { sequelize } from "./sequelize.js";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// glob patterns need POSIX separators. On Windows join() yields backslashes and
// umzug silently finds zero migrations, reporting "nothing pending".
const migrationsGlob = join(__dirname, "../migrations/*.{ts,js}").replace(/\\/g, "/");

export const migrator = new Umzug({
  migrations: {
    glob: migrationsGlob,
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
