// "Can this image start with this environment?" — asked before the database is
// touched, and that order is the whole reason this file exists.
//
// The image migrates and then serves (`CMD` in the Dockerfile). The server
// refuses to start without its required configuration, which is right, but it
// finds out *after* the migrations ran: `index.ts` is the second link in the
// chain. A deploy with one variable missing or mistyped therefore went
//
//   migrate (irreversible) → server exits → Coolify rolls back
//
// and left the previous container running on a schema it cannot boot against —
// the image of `master` re-runs a migration the new runner renamed, fails on
// "column already exists", and never comes up again after its next restart.
// Seen on 10 October 2026 by reading Coolify's panel: production held six
// variables and this version requires nine more.
//
// So the same three refusals `index.ts` makes are made here first. If any of
// them fires, the chain stops with the database untouched, the new container
// never becomes healthy, and the previous version carries on exactly as it was.
//
// **Not a second copy of the rules.** Every check is a function exported from
// `config/security.ts` and called here the way `index.ts` calls it; what lives
// in this file is only the order and the sentences. `preflight.test.ts` reads
// `index.ts` and fails if it starts refusing to boot over something this file
// does not ask about.
//
// It imports nothing that connects to anything. That is deliberate, and it is
// why this is not simply `index.ts` with a flag: importing `index.ts` opens the
// database pool.

import { pathToFileURL } from "node:url";
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_SECURE,
  configuracionDeCorreo,
  cookieNameCarriesHostPrefix,
  requiredEnv,
} from "../config/security.js";
import { log } from "../utils/logger.js";

/**
 * Every reason this environment cannot start the server, in the order
 * `index.ts` would meet them. Empty when it can.
 *
 * All of them, not the first: somebody filling in nine variables on deploy day
 * should not learn about them one failed deploy at a time.
 */
export function problemasDeEntorno(
  env: NodeJS.ProcessEnv,
  nodeEnv: string | undefined,
): string[] {
  const problemas: string[] = [];

  const faltan = requiredEnv(nodeEnv).filter((v) => !env[v]);
  if (faltan.length > 0) {
    problemas.push(`faltan variables obligatorias: ${faltan.join(", ")}`);
  }

  const correo = configuracionDeCorreo(env, nodeEnv);
  if (!correo.ok) {
    problemas.push(
      "la cadena de correo está vacía: ningún proveedor de MAIL_PROVIDERS tiene su configuración completa" +
        (correo.errores?.length ? ` (${correo.errores.join("; ")})` : ""),
    );
  }

  if (!cookieNameCarriesHostPrefix(SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE)) {
    problemas.push(
      `COOKIE_NAME ("${SESSION_COOKIE_NAME}") debe empezar por "__Host-" cuando la cookie es Secure`,
    );
  }

  return problemas;
}

// Only when executed directly — the same guard `database/migrate.ts` uses, so
// that importing this from a test does not end the test run.
const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  const preflightLog = log("preflight");
  const problemas = problemasDeEntorno(process.env, process.env.NODE_ENV);
  if (problemas.length > 0) {
    for (const problema of problemas) {
      preflightLog.fatal({}, `${problema}. No se migra ni se arranca.`);
    }
    process.exit(1);
  }
  preflightLog.info("configuración completa: se puede migrar y arrancar");
}
