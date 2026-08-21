import { Umzug, SequelizeStorage } from "umzug";
import { QueryTypes, type QueryInterface } from "sequelize";
import { sequelize } from "./sequelize.js";
import { log } from "../utils/logger.js";
import { fileURLToPath, pathToFileURL } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// glob patterns need POSIX separators. On Windows join() yields backslashes and
// umzug silently finds zero migrations, reporting "nothing pending".
const migrationsGlob = join(__dirname, "../migrations/*.{ts,js}").replace(/\\/g, "/");

// `*.{ts,js}` also matches `*.test.ts`. Migration tests live next to the
// migration they test, same as everywhere else in this codebase, so without
// this `ignore` umzug picks up e.g. `add-account-lockout.test.ts`, sorts it
// before the real migration (".test.ts" < ".ts" alphabetically), imports it as
// if it were a migration module, and calls `.up()` on a vitest spec that
// exports no `up`. That throws before the real migration ever runs, and
// `npm run migrate` dies on startup.
//
// `.test.js` is listed too, even though today's deploy is safe without it —
// `tsconfig.json` excludes `src/**/*.test.ts` from `npm run build`, so
// `dist/migrations` never gets one. That safety lives in a different file
// from this one, though, and `tsconfig.check.json` (no `noEmit`) would happily
// emit it if ever run by hand. Ignoring both extensions here makes the
// invariant local instead of borrowed.
const migrationsIgnore = ["**/*.test.ts", "**/*.test.js"];

/** The same migration is a .ts source in development and a .js build artefact. */
const withoutExtension = (name: string) => name.replace(/\.(ts|js)$/, "");

interface MigrationModule {
  up: (params: { context: QueryInterface }) => Promise<void>;
  down: (params: { context: QueryInterface }) => Promise<void>;
}

const migrateLog = log("migrate");

export const migrator = new Umzug({
  migrations: {
    glob: [migrationsGlob, { ignore: migrationsIgnore }],
    /**
     * Records migrations without their extension.
     *
     * umzug keys its registry on the file name, extension included, so the very
     * same migration was stored as "…-add-missing-fields.ts" after a local run
     * and "…-add-missing-fields.js" after a deployed one. Each environment kept
     * a separate history of identical work: this database holds both rows, which
     * means that migration ran twice. Restoring a production dump locally would
     * have replayed every migration in it.
     */
    resolve: ({ name, path, context }) => ({
      name: withoutExtension(name),
      up: async () => {
        // pathToFileURL, not the bare path: Windows absolute paths are not valid
        // import specifiers ("C:" reads as a protocol).
        const migration: MigrationModule = await import(pathToFileURL(path!).href);
        await migration.up({ context });
      },
      down: async () => {
        const migration: MigrationModule = await import(pathToFileURL(path!).href);
        await migration.down({ context });
      },
    }),
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: migrateLog,
});

export interface NormalisationResult {
  /** Rows removed because the same migration was recorded under both extensions. */
  deduplicated: number;
  /** Rows whose name lost its extension. */
  renamed: number;
}

/**
 * Rewrites registry rows written before names dropped their extension.
 *
 * Without this the new naming makes every past migration look pending and umzug
 * replays it. Runs inside one transaction and is safe to repeat: after the first
 * pass nothing matches. The table name is a parameter so it can be exercised
 * against a scratch table instead of the real registry.
 */
export async function normaliseMigrationNames(
  table = "SequelizeMeta",
): Promise<NormalisationResult> {
  const none: NormalisationResult = { deduplicated: 0, renamed: 0 };
  const quoted = `"${table.replace(/"/g, '""')}"`;

  const [present] = await sequelize.query<{ present: string | null }>(
    `SELECT to_regclass('${quoted}')::text AS present`,
    { type: QueryTypes.SELECT },
  );
  if (!present?.present) return none;

  const result = await sequelize.transaction(async (transaction) => {
    // Drop the duplicate first: the column is the primary key, so stripping the
    // extension off both rows of a pair would collide. ".js" sorts before ".ts",
    // and which one survives does not matter — they describe the same work.
    const deduplicated = await sequelize.query(
      `DELETE FROM ${quoted} a
         USING ${quoted} b
        WHERE regexp_replace(a.name, '\\.(ts|js)$', '') = regexp_replace(b.name, '\\.(ts|js)$', '')
          AND a.name > b.name`,
      { transaction, type: QueryTypes.BULKDELETE },
    ) as unknown as number;
    const renamed = await sequelize.query(
      `UPDATE ${quoted}
          SET name = regexp_replace(name, '\\.(ts|js)$', '')
        WHERE name ~ '\\.(ts|js)$'`,
      { transaction, type: QueryTypes.BULKUPDATE },
    ) as unknown as number;
    return { deduplicated, renamed };
  });

  if (result.deduplicated > 0 || result.renamed > 0) {
    migrateLog.info(
      { duplicadas: result.deduplicated, renombradas: result.renamed },
      `registro de migraciones normalizado: ${result.deduplicated} duplicada(s), ` +
      `${result.renamed} renombrada(s)`,
    );
  }
  return result;
}

async function runMigrations() {
  await sequelize.authenticate();
  await normaliseMigrationNames();
  const applied = await migrator.up();
  if (applied.length === 0) {
    migrateLog.info("no hay migraciones pendientes");
  } else {
    migrateLog.info(
      { migraciones: applied.map((m) => m.name) },
      `${applied.length} migración(es) aplicada(s): ${applied.map((m) => m.name).join(", ")}`,
    );
  }
  await sequelize.close();
}

// Only when executed directly. Importing this module from a test must not run
// migrations as a side effect.
const executedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  runMigrations().catch((err) => {
    migrateLog.fatal({ err }, "la migración falló");
    process.exit(1);
  });
}
