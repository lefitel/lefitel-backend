import { Sequelize } from "sequelize";
import dotenv from "dotenv";
import { log } from "../utils/logger.js";

// `quiet` because dotenv 17 prints a line of its own on every load — an
// "injected env (13) from .env" with a tip appended. Everything else this
// process writes to stdout is a pino JSON record, so one plain line at the top
// is what stops a log collector from parsing the boot output.
dotenv.config({ quiet: true });

const dbLog = log("db");

/**
 * Every statement Sequelize runs, at `debug`.
 *
 * It used to print unconditionally, which meant one page load scrolled the
 * terminal past anything worth reading. The short label stays as the message so
 * a query is recognisable at a glance; the whole statement is a field, there for
 * when you need it and out of the way when you do not.
 */
const dbLogger = (sql: string, timing?: number) => {
  if (!dbLog.isLevelEnabled("debug")) return;
  const match = sql.match(/(\w+).*?(?:FROM|INTO|UPDATE) "(\w+)"/i);
  const label = match ? `${match[1]} ${match[2]}` : sql.substring(0, 60);
  dbLog.debug({ sql, ms: timing }, `${label}${timing !== undefined ? ` (${timing}ms)` : ""}`);
};

// Typed rather than inferred: left bare it widens to `any`, and every
// sequelize.query in the codebase silently loses its return type with it.
let sequelize: Sequelize;

/**
 * Where the connection settings came from.
 *
 * Exported because `index.ts` needs it to decide whether rewriting the schema is
 * survivable. A deployment configured with a single `DATABASE_URL` is the shape
 * a hosted database takes; the discrete variables are the shape a local one
 * takes. That is the only signal available at boot that tells the two apart.
 */
let connectionSource: "discrete" | "url" = "url";

/**
 * Explicit pool. The default is 5 connections shared by the whole API, and a
 * report can hold one for up to two statement timeouts. Five concurrent report
 * requests were enough to starve every other endpoint, login included.
 */
const pool = { max: 15, min: 0, acquire: 30_000, idle: 10_000 };

/**
 * Which settings to use follows from which ones exist, not from NODE_ENV.
 *
 * Tying the connection to the environment name coupled two unrelated things: a
 * production container configured with the discrete PG_* variables — the
 * natural setup when Postgres runs beside the API — had to be left in
 * development mode to connect at all, and development mode is what enabled
 * `sync({ alter: true })`. Choosing by variable lets either deployment set
 * NODE_ENV honestly.
 *
 * The discrete variables win when they are complete, and that order is
 * deliberate. A .env carrying both a local PG_DATABASE and a leftover remote
 * DATABASE_URL is common; the harm of pointing development at the remote
 * database is far greater than the harm of the reverse. The chosen source is
 * logged so a wrong one is visible on the first line of the log.
 */
if (process.env.PG_DATABASE && process.env.PG_USER) {
  connectionSource = "discrete";
  dbLog.info(
    { base: process.env.PG_DATABASE, host: process.env.PG_IP, puerto: process.env.PG_PORT },
    `conectando a ${process.env.PG_DATABASE} en ${process.env.PG_IP}:${process.env.PG_PORT}`,
  );
  sequelize = new Sequelize(
    process.env.PG_DATABASE,
    process.env.PG_USER,
    process.env.PG_PASS,
    {
      host: process.env.PG_IP,
      port: Number(process.env.PG_PORT),
      dialect: "postgres",
      logging: dbLogger,
      benchmark: true,
      pool,
    }
  );
} else if (process.env.DATABASE_URL) {
  connectionSource = "url";
  dbLog.info("conectando por DATABASE_URL");
  sequelize = new Sequelize(process.env.DATABASE_URL, { logging: dbLogger, benchmark: true, pool });
} else {
  // This module is imported before index.ts runs, so the guard belongs here.
  // Without it, `new Sequelize(undefined)` throws about a missing dialect,
  // which says nothing about the variable that is actually missing.
  dbLog.fatal(
    "falta la configuración de la base de datos. " +
    "Define DATABASE_URL, o bien PG_DATABASE, PG_USER, PG_PASS, PG_IP y PG_PORT.",
  );
  process.exit(1);
}

export { sequelize, connectionSource };
