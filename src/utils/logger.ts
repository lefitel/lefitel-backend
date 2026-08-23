import pino, { type LoggerOptions } from "pino";
import pretty from "pino-pretty";
import { execFileSync } from "node:child_process";

/**
 * The server's technical log.
 *
 * Not to be confused with the bitácora. That one is the business record: it goes
 * to the database, it says who archived which event, and the client reads it.
 * This one is for whoever is trying to work out why the server did something. It
 * goes to standard output and nobody outside the team ever sees it.
 *
 * One line per event, always. In development it is coloured and laid out for
 * eyes; in production it is JSON, which is what makes "every error from user 14
 * yesterday afternoon" a search rather than an afternoon of reading. Same lines,
 * two coats of paint — never two logging systems to keep in step.
 */

const isProduction = process.env.NODE_ENV === "production";

/**
 * Silent under vitest unless asked otherwise.
 *
 * A test suite that prints the server's log prints it for the passing tests too,
 * and the failure you are looking for ends up between forty lines of "conectando
 * a osefi_local". `LOG_LEVEL=debug npm test` still shows everything when you are
 * chasing something specific.
 *
 * Declared up here because the console fix below needs it too.
 */
const underTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";

/**
 * Make the Windows console read UTF-8.
 *
 * Node writes UTF-8 and cannot change how a terminal decodes it. A Spanish
 * Windows install starts its consoles on code page 850, which reads those bytes
 * as Latin-1 and turns "el puerto ya está ocupado" into "ya est├í ocupado" —
 * every accent in every message, and the messages are Spanish throughout.
 *
 * `chcp` changes the code page of the console attached to the process, and a
 * child process shares that console, so running it from here fixes this window.
 * Guarded to Windows and skipped in production, where there is no console to
 * attach to and the output is JSON going to a log collector. It failing is not
 * worth stopping for: the worst case is the accents look wrong, which is where
 * we already were.
 *
 * Skipped under test as well, and that one is not cosmetic: `execFileSync`
 * blocks, vitest runs one worker per test file, and every worker that imported
 * this module paid for its own `chcp.com`. On a cold run it added five seconds
 * and made `logger.test.ts` fail its own timeout — a test suite that is
 * nondeterministic on a clean checkout. There is no console here worth fixing:
 * vitest captures the output.
 */
if (process.platform === "win32" && !isProduction && !underTest) {
  try {
    execFileSync("chcp.com", ["65001"], { stdio: "ignore" });
  } catch {
    // No console attached, or chcp missing. Nothing to do and nothing to say.
  }
}

/**
 * How much to say.
 *
 * `info` by default in both, deliberately. Every SQL statement Sequelize runs is
 * logged at `debug`, and with those on the terminal scrolls hundreds of lines
 * per page load — the interesting one goes past before you can read it. Set
 * `LOG_LEVEL=debug` when you actually want to watch the queries.
 */

const level = process.env.LOG_LEVEL ?? (underTest ? "silent" : "info");

/**
 * Values that must never reach a log file.
 *
 * Session cookies travel on `set-cookie`, the legacy bearer token still arrives
 * on `authorization`, and passwords arrive in bodies on three endpoints. All of
 * them are replaced with `[oculto]` before anything is written, by the logger
 * itself rather than by remembering at each call site.
 *
 * `x-new-token` stays on the list even though nothing emits it any more: the
 * server used to re-sign a JWT onto that header on every response, and
 * `ROLE_HEADER` replaced it. Redaction is not where a dead name gets cleaned
 * up — the cost of a stale entry is one string compared per response, and the
 * cost of removing one that turns out to be live is a working credential on
 * disk for every request the server has ever answered.
 */
export const REDACT_CENSOR = "[oculto]";

/** Exported so `logger.test.ts` can pin the paths themselves. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["x-new-token"]',
  'res.headers["set-cookie"]',
  "pass",
  "oldPass",
  "password",
  "token",
  "*.pass",
  "*.oldPass",
  "*.password",
  "*.token",
] as const;

const redact = { paths: [...REDACT_PATHS], censor: REDACT_CENSOR };

const options: LoggerOptions = {
  level,
  redact,
  base: { name: "api" },
  // Pino's own level names are English and its numbers are meaningless at a
  // glance; the pretty printer below shows the name.
  formatters: { level: (label) => ({ level: label }) },
};

/**
 * Pretty output as a stream rather than a transport.
 *
 * The documented way is `transport: { target: "pino-pretty" }`, which moves the
 * formatting to a worker thread. That worker can lose the last few lines when
 * the process exits, and under `tsx watch` on Windows the restarts make that
 * common — exactly the lines you want when something crashes on boot. As a
 * stream it formats in-process and nothing is ever in flight.
 */
export const logger = isProduction
  ? pino(options)
  : pino(
      options,
      pretty({
        colorize: true,
        // "SYS:" means the machine's clock. Without it pino-pretty prints UTC,
        // so a server in Bolivia stamped its lines four hours in the future and
        // nothing lined up with the wall clock you were watching it on.
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname,name",
        messageFormat: "{if module}[{module}] {end}{msg}",
        singleLine: false,
      }),
    );

/**
 * A logger that stamps every line with where it came from.
 *
 * `log("db").warn("…")` prints `[db] …` and, in production, carries
 * `"module":"db"` as a field you can filter on.
 */
export const log = (module: string) => logger.child({ module });
