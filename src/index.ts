import app from "./app.js";

import dotenv from "dotenv";
import { connectionSource, sequelize } from "./database/sequelize.js";
import { log } from "./utils/logger.js";

dotenv.config();

const bootLog = log("boot");

/**
 * Stop, having said why, without jumping the queue.
 *
 * `process.exit()` cuts the process off where it stands, and anything still
 * sitting in the output stream can land out of order or not at all — the boot
 * failure printed *above* the "connected to PostgreSQL" line that came before
 * it, which reads as though the failure happened first.
 *
 * Setting the code and letting the loop drain fixes the order. The timer is the
 * backstop for something refusing to let go; it is unref'd, so it never keeps
 * the process alive on its own account.
 */
function die(): void {
  process.exitCode = 1;
  void sequelize.close().catch(() => undefined);
  setTimeout(() => process.exit(1), 2000).unref();
}

/**
 * Without it nothing can be signed or verified, so there is no point continuing.
 *
 * `process.exit()` right here, rather than `die()`: this runs at the top of the
 * module, so merely setting the exit code would let everything below it —
 * connecting, migrating, listening — run to completion first. And there is
 * nothing queued ahead of this line for the exit to cut off.
 */
if (!process.env.JWT_SECRET) {
  bootLog.fatal("JWT_SECRET no está definido. El servidor no puede arrancar.");
  process.exit(1);
}

/**
 * The last net: say what killed the process, then let it die.
 *
 * Node ends the process on an unhandled rejection and prints a raw stack, which
 * in production is a container that restarts with nothing in the log explaining
 * why. Express 4 makes this easy to hit — it drops the rejected promise of any
 * `async` middleware — and the permission gates are exactly that shape.
 *
 * This does not keep a broken process alive: after an unhandled rejection or an
 * uncaught exception the state is unknown, and serving requests from unknown
 * state is worse than restarting. It only guarantees a readable last line.
 */
process.on("unhandledRejection", (reason) => {
  bootLog.fatal({ err: reason }, "promesa rechazada sin capturar: el proceso termina");
  die();
});

process.on("uncaughtException", (err) => {
  bootLog.fatal({ err }, "excepción sin capturar: el proceso termina");
  die();
});

const port = process.env.PORT || 3000;

/**
 * Rewriting the schema to match the models is destructive: it drops and alters
 * real columns. It used to run whenever NODE_ENV was not "production", which
 * meant a container that merely forgot the variable reshaped the live database
 * on every boot. Then it took saying `DB_SYNC=true` — better, but a variable in
 * a file is one careless line away from pointing somewhere it should not.
 *
 * So asking is no longer enough. It also has to be a connection assembled from
 * the discrete PG_* variables, which is how a local database is configured; a
 * `DATABASE_URL` is how a hosted one is, and this refuses to touch those
 * whatever the flag says. Commenting out PG_DATABASE to debug for five minutes
 * used to be all it took to reshape production on the next boot.
 *
 * It also contradicts the migrations. Enable it only against a local database
 * you are willing to lose.
 */
const syncRequested = process.env.DB_SYNC === "true";
const shouldSyncSchema = syncRequested && connectionSource === "discrete";

async function main() {
  bootLog.info(
    { entorno: process.env.NODE_ENV ?? "sin definir", nivel: process.env.LOG_LEVEL ?? "info" },
    `entorno ${process.env.NODE_ENV ?? "sin definir"}`,
  );

  if (syncRequested && !shouldSyncSchema) {
    bootLog.error(
      "DB_SYNC=true pero la conexión viene de DATABASE_URL: NO se sincroniza. " +
      "sync({ alter: true }) reescribe columnas reales y esa es la forma de una base alojada. " +
      "Si de verdad quieres sincronizar, configura PG_DATABASE, PG_USER, PG_PASS, PG_IP y PG_PORT.",
    );
  }

  if (shouldSyncSchema) {
    bootLog.warn("DB_SYNC=true: sincronizando el esquema con los modelos");
    await sequelize.sync({ alter: true });
  } else {
    await sequelize.authenticate();
  }
  bootLog.info("conexión establecida con PostgreSQL");

  const server = app.listen(port, () => {
    bootLog.info({ puerto: port }, `escuchando en el puerto ${port}`);
  });

  /**
   * `listen` reports its failures as an event, not as a rejected promise, so the
   * catch around main() never sees them. Without this, the commonest boot
   * failure there is — another copy of the server still holding the port —
   * printed a Node stack trace and the words EADDRINUSE, which say what happened
   * only if you already know.
   */
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      bootLog.fatal(
        { puerto: port },
        `el puerto ${port} ya está ocupado. Seguramente hay otro servidor corriendo: ` +
        `ciérralo, o arranca este con otro PORT.`,
      );
    } else {
      bootLog.fatal({ err }, "el servidor no pudo escuchar");
    }
    die();
  });
}

main().catch((err) => {
  // Without this an unreachable database killed the process with an unhandled
  // rejection: a stack trace and no sentence saying what went wrong.
  bootLog.fatal({ err }, "el servidor no pudo arrancar");
  die();
});
