import app from "./app.js";

import dotenv from "dotenv";
import { sequelize } from "./database/sequelize.js";

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error("ERROR: JWT_SECRET no está definido. El servidor no puede arrancar.");
  process.exit(1);
}

const port = process.env.PORT || 3000;

/**
 * Rewriting the schema to match the models is destructive: it drops and alters
 * real columns. It used to run whenever NODE_ENV was not "production", which
 * meant a container that merely forgot the variable reshaped the live database
 * on every boot. Now it takes saying so, and the name says what it does.
 *
 * It also contradicts the migrations. Enable it only against a local database
 * you are willing to lose.
 */
const shouldSyncSchema = process.env.DB_SYNC === "true";

async function main() {
  console.log(`--> Entorno: ${process.env.NODE_ENV ?? "sin definir"} <--`);

  if (shouldSyncSchema) {
    console.warn("--> DB_SYNC=true: sincronizando el esquema con los modelos <--");
    await sequelize.sync({ alter: true });
  } else {
    await sequelize.authenticate();
  }
  console.log("--> Conexión establecida con PostgreSQL <--");

  app.listen(port, () => {
    console.log(
      "--> Servidor y socket en funcionamiento en el puerto: " + port + " <--"
    );
  });
}

main();
