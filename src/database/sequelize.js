import Sequelize from "sequelize";
import dotenv from "dotenv";
import pgConect from "pg-connection-string";

const { parse } = pgConect;
dotenv.config();

/*
const database = process.env.PG_DATABASE;
const user = process.env.PG_USER;
const pass = process.env.PG_PASS;
const host = process.env.PG_IP;

export const sequelize = new Sequelize(database, user, pass, {
  host: host,
  dialect: "postgres",
});
*/
const connectionString = process.env.DATABASE_URL;
const connector = parse(connectionString);

export const sequelize = new Sequelize(connectionString);

/*export const sequelize = new Sequelize(
  connector.database,
  connector.user,
  connector.password,
  {
    dialect: "postgres",
    host: connector.host,
    dialectOptions: {
      ssl: { sslmode: "require", rejectUnauthorized: false },
    },
  }
);*/

/*export const sequelize = new Sequelize(
    connector.database,
    connector.user,
    connector.password,
    {
        dialect: "postgres",
        host: connector.host,
    }
)*/
