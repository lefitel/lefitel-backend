import { Sequelize } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

let sequelize;

if (process.env.NODE_ENV === "production") {
  sequelize = new Sequelize(process.env.DATABASE_URL);
} else {
  sequelize = new Sequelize(
    process.env.PG_DATABASE,
    process.env.PG_USER,
    process.env.PG_PASS,
    {
      host: process.env.PG_IP,
      port: Number(process.env.PG_PORT),
      dialect: "postgres",
    }
  );
}

export { sequelize };
