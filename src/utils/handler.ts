// The one thing that turns an unexpected failure into a 500 instead of a
// hanging request, shared by every controller that needs it.
//
// Express 4 does not catch a rejected promise from an `async` route handler:
// it never reaches the terminal handler in `app.ts`, the request just hangs
// until the client gives up. `auth.controller.ts` wrote this first, and
// `email.controller.ts` copied it rather than importing it — copied on
// purpose at the time, to avoid pulling `auth.controller.ts`'s whole import
// graph (`sessionStore.js`, `credentials.js`, `permissions/store.js`,
// `bcryptjs`) into a test for two unrelated endpoints. That reasoning was
// right about the coupling and wrong about the fix: the coupling is what
// `makeHandler` below removes, by living in a module with no imports of its
// own beyond Express's types, rather than what copying the function was
// papering over. Task 5's two endpoints were the second sign this needed to
// move: a third copy of the same fifteen lines is not a coincidence, it is a
// pattern that will keep recurring, and a fix to the wrapper — the request id
// added to the log line, say — would then have to be found and repeated in
// three places, with the fourth left behind being the likely outcome.

import type { Request, Response } from "express";

const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";

/**
 * The one thing every logger passed in here is asked to do.
 *
 * Not a fixed `import { log } from "./logger.js"` instance: every controller
 * already opens its own with its own module name (`authLog`, `emailLog`), so
 * that a failure is filed under the file that raised it rather than a shared,
 * undifferentiated "handler" bucket in the log. Taking it as a parameter to
 * `makeHandler` is what makes one wrapper usable by more than one of them
 * without merging their logs into one name.
 */
interface FailureLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Build the wrapper for one controller file, bound to that file's own logger.
 *
 * Called once per controller module (`const handler = makeHandler(authLog);`),
 * so every individual route handler below it is written exactly as it was
 * before this was extracted — `handler("name", async (req, res) => { ... })`
 * — and the diff of moving a controller onto this module is the setup line
 * plus an import, not a change to every call site.
 */
export function makeHandler(log: FailureLogger) {
  return function handler(name: string, fn: (req: Request, res: Response) => Promise<unknown>) {
    const wrapped = async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        log.error({ err, ruta: req.originalUrl }, `fallo en ${name}`);
        if (!res.headersSent) {
          res.status(500).json({ message: ERROR_INESPERADO });
        }
      }
    };
    // The name survives the wrapper because `routeGuards.test.ts` reads the
    // handler names off the assembled app to tell a gated route from an open
    // one.
    Object.defineProperty(wrapped, "name", { value: name });
    return wrapped;
  };
}
