import { Sequelize } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

const dbLogger = (sql: string, timing?: number) => {
  const match = sql.match(/(\w+).*?(?:FROM|INTO|UPDATE) "(\w+)"/i);
  const label = match ? `${match[1]} ${match[2]}` : sql.substring(0, 60);
  console.log(`[DB] ${label}${timing !== undefined ? ` (${timing}ms)` : ""}`);
};

let sequelize;

if (process.env.NODE_ENV === "production") {
  sequelize = new Sequelize(process.env.DATABASE_URL, { logging: dbLogger, benchmark: true });
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
    }
  );
}

export { sequelize };
