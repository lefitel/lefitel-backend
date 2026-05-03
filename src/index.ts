import app from "./app.js";

import dotenv from "dotenv";
import { sequelize } from "./database/sequelize.js";

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error("ERROR: JWT_SECRET no está definido. El servidor no puede arrancar.");
  process.exit(1);
}

const port = process.env.PORT || 3000;

async function main() {
  if (process.env.NODE_ENV !== "production") {
    console.log(`--> Entorno: DEVELOPMENT <--`);
  }

  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
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
