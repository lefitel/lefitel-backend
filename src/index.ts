import app from "./app.js";

import dotenv from "dotenv";
import { sequelize } from "./database/sequelize.js";
import { log } from "./utils/logger.js";
import {
  requiredEnv,
  configuracionDeCorreo,
  fillerHash,
  SESSION_PURGE_INTERVAL_MS,
  REMEMBERED_DEVICE_PURGE_INTERVAL_MS,
  cookieNameCarriesHostPrefix,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_SECURE,
} from "./config/security.js";
import { createShutdown } from "./lifecycle.js";
import { schedulePurge } from "./auth/purgeJob.js";
import { purgeExpiredSessions } from "./auth/sessionStore.js";
import { purgeExpiredRememberedDevices } from "./auth/rememberedDeviceStore.js";
import { comprobarLlaveAlArrancar } from "./auth/mfaKeyCheck.js";
import { configurarRelevo } from "./auth/mailRelay.js";

// `quiet` because dotenv 17 prints a line of its own on every load — an
// "injected env (13) from .env" with a tip appended. Everything else this
// process writes to stdout is a pino JSON record, so one plain line at the top
// is what stops a log collector from parsing the boot output.
dotenv.config({ quiet: true });

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
 * Nothing is required outside production any more — the session cookie is the
 * only credential, and there is no key left to sign or verify. In production,
 * a missing CORS_ORIGIN would let the origin check fall back to a value
 * nobody chose, and a missing COOKIE_NAME or COOKIE_SECURE would let the
 * session cookie fall back to defaults with no `__Host-` guarantee, silently.
 * Either way there is no point continuing.
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
 * The mail chain (plan 4E), checked here for the same reason and in the same
 * place as `requiredEnv`: before anything is queued, so that an exit is an
 * exit. `requiredEnv` proved `MAIL_PROVIDERS` is *set*; this reads its value
 * and finds out whether each provider it names has its credentials.
 *
 * **What exits and what does not, and why the line is where it is.** A
 * provider with an incomplete configuration is dropped from the chain and
 * logged at `fatal` — the first screen of the log, by name of the variable
 * that is missing, never its value — and the process boots with the rest. A
 * chain of four is a degraded chain; a process that refuses to start over a
 * typo is an outage for nine people whose only second factor is now the
 * email, which is the rule `comprobarLlaveAlArrancar` below already applies
 * to the TOTP key. What does exit is an **empty** chain in production: that
 * is the silent no-send `requiredEnv` exists to turn into a deploy failure,
 * and with the code by email on the login path it would close the ERP to
 * everybody by the second login.
 *
 * The configuration object carries variable names, never secrets, so it is
 * logged whole.
 */
const correo = configuracionDeCorreo(process.env, process.env.NODE_ENV);
if (!correo.ok) {
  bootLog.fatal(
    { errores: correo.errores },
    "la cadena de correo está vacía: ningún proveedor de MAIL_PROVIDERS tiene su configuración completa. El servidor no puede arrancar.",
  );
  process.exit(1);
}
for (const descartado of correo.descartados) {
  const linea = process.env.NODE_ENV === "production" ? bootLog.fatal.bind(bootLog) : bootLog.warn.bind(bootLog);
  linea(
    { proveedor: descartado.nombre, motivo: descartado.motivo },
    `proveedor de correo DESCARTADO de la cadena: ${descartado.nombre} — ${descartado.motivo}`,
  );
}
configurarRelevo(correo);
bootLog.info(
  { modo: correo.modo, cadena: correo.proveedores.map((p) => `${p.nombre}(${p.cupoDiario}/día)`) },
  correo.modo === "envia"
    ? `cadena de correo: ${correo.proveedores.map((p) => p.nombre).join(" → ")}`
    : "correo en modo desarrollo: no se envía nada",
);

/**
 * `requiredEnv` only proves `COOKIE_NAME` was set, not that it can deliver
 * what a `Secure` cookie relies on. `__host-osefi_session`, `_Host-...`, or
 * a plain name with no prefix at all would all pass that check, boot clean,
 * and log in fine — a browser grants the `__Host-` protection to nothing
 * less than the exact prefix, so any of those ships a cookie a hostile
 * subdomain can shadow, silently. See `cookieNameCarriesHostPrefix`.
 */
if (!cookieNameCarriesHostPrefix(SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE)) {
  bootLog.fatal(
    { nombre: SESSION_COOKIE_NAME },
    `COOKIE_NAME ("${SESSION_COOKIE_NAME}") debe empezar por "__Host-" cuando la cookie es Secure. El servidor no puede arrancar.`,
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

async function main() {
  bootLog.info(
    { entorno: process.env.NODE_ENV ?? "sin definir", nivel: process.env.LOG_LEVEL ?? "info" },
    `entorno ${process.env.NODE_ENV ?? "sin definir"}`,
  );

  // The schema comes from the migrations and only from them. `sync({ alter:
  // true })` used to live here behind a flag; it drops any column the model
  // does not declare, which for a model written with default timestamps
  // against a table with explicit ones means dropping real data on boot. The
  // flag was one careless line away from pointing at production, and with the
  // session and factor tables coming, what it would take with it grew.
  await sequelize.authenticate();
  bootLog.info("conexión establecida con PostgreSQL");

  /**
   * Whether `MFA_ENCRYPTION_KEY_ACTIVE` actually opens what it is supposed
   * to — see `auth/mfaKeyCheck.ts` for the full reasoning (Decisions 1 and 2
   * of `docs/plans/2026-09-01-factores-mfa.md`, findings A6, B8, B9). The
   * short version: `requiredEnv` above only proved the variable was *set*;
   * this proves it *works*, by resolving the keyring and, if a confirmed
   * TOTP row exists, decrypting it.
   *
   * 🔴 A failure here must never reach `die()` or `process.exit`, and must
   * never move above this line. Doing either would mean a single typo'd env
   * var takes down the whole ERP for all nine people, including everyone who
   * has never touched MFA — Decision 2's entire point, and the reason this
   * check lives in `index.ts` rather than in `config/security.ts`: the
   * rescue script (`scripts/rescue.ts`) imports that file and has to keep
   * working precisely when this key is broken, since resetting MFA is how
   * someone recovers from that. `mfaKeyCheck.test.ts` walks rescue's own
   * import graph to keep it that way. A failed check only logs and flips the
   * switch `/auth/totp/*` (Task 6) reads to answer 503 with — everything
   * else keeps running.
   */
  const comprobacionMfa = await comprobarLlaveAlArrancar();
  if (!comprobacionMfa.ok) {
    bootLog.fatal(
      { detalle: comprobacionMfa.detalle },
      `la clave de cifrado del segundo factor no es válida (${comprobacionMfa.detalle}). ` +
        "El servidor sigue en pie: /auth/totp/* responderá 503 hasta que se corrija; " +
        "el resto del ERP, incluida la recuperación por código, sigue funcionando.",
    );
  }

  /**
   * Starts the background purge of expired sessions: one pass now, then daily
   * for as long as the process runs. Nothing else deletes from `sesiones`
   * (see `purgeExpiredSessions`'s own comment), so without this the table
   * only grows.
   *
   * `schedulePurge` carries its own `.catch` at the exact point it calls
   * `purgeExpiredSessions` — same shape, and same reason, as `fillerHash()`
   * below: a promise rejected here with nobody holding it is an
   * `unhandledRejection` in `index.ts`, and that handler kills the process. A
   * midnight where the database happens to be unreachable must not take the
   * whole ERP down with it — see `purgeJob.ts` for the rest of the reasoning,
   * including why its interval is `unref`'d.
   */
  schedulePurge({
    purge: purgeExpiredSessions,
    intervalMs: SESSION_PURGE_INTERVAL_MS,
    onError: (err) => bootLog.warn({ err }, "no se pudo purgar las sesiones caducadas"),
  });

  /**
   * And the sweep of `dispositivo_recordado`, on its own timer rather than
   * chained behind the one above.
   *
   * `schedulePurge` takes exactly one `purge`, so the obvious alternative was
   * to hand it a function that awaits both. That version has a failure mode
   * this one does not: a session sweep that throws — a lock timeout, a database
   * that blinked — takes the device sweep down with it and reports the failure
   * under the sessions' message, so the table quietly holding IP addresses and
   * user agents keeps growing while the log talks about something else. Two
   * calls, two `.catch`es, two messages: either sweep can fail on a given
   * midnight without touching the other, and the log names the one that did.
   *
   * Nor is this opportunistic on login the way `purgeExpiredTokens` is. The
   * reason written beside that one (`tokenStore.ts`) is that a daily interval
   * is one more moving part that can stop running without anyone noticing,
   * where a login happens constantly and for free — and it was written when
   * this very interval already existed and was already wired here, so it is an
   * argument about intervals in general, not about a job that had yet to be
   * built.
   *
   * Taken at its word, it still does not carry to this table, because what the
   * two sweeps bound is not the same thing. A token nobody purges is a row that
   * can no longer be redeemed; a device nobody purges is an IP address and a
   * user agent still sitting on disk. How long personal data is kept cannot
   * depend on how busy the ERP is — a quiet fortnight is precisely when no
   * login arrives to carry the sweep, and it is not a fortnight in which the
   * reason for deleting the rows goes away. The interval runs whether anybody
   * works that day or not.
   *
   * Both intervals are `unref`'d by `schedulePurge`, so this does not give the
   * process a second reason to stay alive.
   */
  schedulePurge({
    purge: purgeExpiredRememberedDevices,
    intervalMs: REMEMBERED_DEVICE_PURGE_INTERVAL_MS,
    onError: (err) => bootLog.warn({ err }, "no se pudo purgar los dispositivos recordados"),
  });

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
