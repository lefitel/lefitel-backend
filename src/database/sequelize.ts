import { Sequelize } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

const dbLogger = (sql: string, timing?: number) => {
  const match = sql.match(/(\w+).*?(?:FROM|INTO|UPDATE) "(\w+)"/i);
  const label = match ? `${match[1]} ${match[2]}` : sql.substring(0, 60);
  console.log(`[DB] ${label}${timing !== undefined ? ` (${timing}ms)` : ""}`);
};

let sequelize;

/**
 * Explicit pool. The default is 5 connections shared by the whole API, and a
 * report can hold one for up to two statement timeouts. Five concurrent report
 * requests were enough to starve every other endpoint, login included.
 */
const pool = { max: 15, min: 0, acquire: 30_000, idle: 10_000 };

if (process.env.NODE_ENV === "production") {
  sequelize = new Sequelize(process.env.DATABASE_URL, { logging: dbLogger, benchmark: true, pool });
} else {
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
}

export { sequelize };
