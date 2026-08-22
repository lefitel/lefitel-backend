import app from "./app.js";

import dotenv from "dotenv";
import { connectionSource, sequelize } from "./database/sequelize.js";
import { log } from "./utils/logger.js";
import { requiredEnv, fillerHash } from "./config/security.js";
import { createShutdown } from "./lifecycle.js";

dotenv.config();

const bootLog = log("boot");

/** Set once the server is listening, so `die()` can stop it accepting. */
let listener: import("node:http").Server | null = null;

/**
 * How this process stops. The reasoning, and the order the two closes have to
 * happen in, live in `lifecycle.ts` — where they can be tested.
 */
const die = createShutdown({
  closeListener: () => listener?.close(),
  closeDatabase: () => sequelize.close(),
  forceExit: (code) => process.exit(code),
});

/**
 * Without JWT_SECRET nothing can be signed or verified; without CORS_ORIGIN in
 * production the origin check would fall back to a value nobody chose. Either
 * way there is no point continuing.
 *
 * `process.exit()` right here, rather than `die()`: this runs at the top of the
 * module, so merely setting the exit code would let everything below it —
 * connecting, migrating, listening — run to completion first. And there is
 * nothing queued ahead of this line for the exit to cut off.
 */
const missing = requiredEnv(process.env.NODE_ENV).filter((v) => !process.env[v]);
if (missing.length > 0) {
  bootLog.fatal(
    { faltan: missing },
    `faltan variables obligatorias: ${missing.join(", ")}. El servidor no puede arrancar.`,
  );
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

  /**
   * Warms the login filler-hash cache during boot, in parallel with whatever
   * else start-up is doing, rather than leaving it lazy. Memoization alone
   * still makes *someone* pay for the first bcrypt round after a cold start;
   * without this, that someone is whichever request happens to try an
   * unknown username first, and for that one request the unknown-user path
   * costs hash + compare while a wrong password against a real account costs
   * only compare — the exact timing asymmetry this mechanism exists to
   * remove, just narrowed to once per process instead of every time.
   *
   * Fire-and-forget, but not `void` on its own: `fillerHash()`'s internal
   * `.catch` clears its cache and rethrows on failure so a later call can
   * retry, which means the promise returned here can still be rejected. An
   * unhandled rejection at boot hits the `process.on("unhandledRejection")`
   * handler above and kills the process — exactly what this call must not
   * do. The `.catch` below is what actually keeps a failure here from
   * stopping the server: log it and move on, since the next `fillerHash()`
   * call (the first real login) will simply try again.
   */
  fillerHash().catch((err) => bootLog.warn({ err }, "no se pudo precalentar el hash de relleno"));

  const server = app.listen(port, () => {
    bootLog.info({ puerto: port }, `escuchando en el puerto ${port}`);
  });
  listener = server;

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
