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
 *
 * `warn` is here for the same reason `error` is: a request the caller got wrong
 * is worth a line, and it must not be that line. An error log where half the
 * entries are somebody forgetting a field is an error log nobody reads.
 */
interface FailureLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * The shape of the four failures below, read off the exception rather than
 * imported from Sequelize.
 *
 * By name and not `instanceof`, which is the house convention already —
 * `usuario.controller.ts`, `email.controller.ts`, `emailCodeStore.ts` and
 * `rescueCore.ts` all check `err.name === "SequelizeUniqueConstraintError"`.
 * It also keeps this module's one real property: it imports nothing but
 * Express's types, so `email.controller.test.ts` does not pull the ORM in to
 * test two endpoints that never touch it.
 */
interface FalloDeSequelize {
  name?: string;
  /** One item per failing column on a `ValidationError`. */
  errors?: Array<{ path?: string | null; type?: string | null }>;
  parent?: { code?: string };
  original?: { code?: string };
}

interface FalloDelQueLlama {
  status: number;
  message: string;
}

/**
 * SQLSTATE class 22 is "data exception": every way a value can be wrong for the
 * column it is compared against — unreadable as a number, out of range, past
 * the width of the column, a bad cast.
 *
 * The same rule `generador.controller.ts` uses, and the same reason: what the
 * caller must not get is the 500 they used to get. Unlike the four named
 * failures below, this one arrives with no usable list of columns, so the
 * sentence stays generic.
 */
const esExcepcionDeDatos = (codigo: unknown): boolean =>
  typeof codigo === "string" && codigo.startsWith("22");

/**
 * Turn one of the failures the caller caused into the answer it earns, or
 * `null` for everything else.
 *
 * **Why this exists.** Every converted controller funnels its failures into one
 * `catch`, and that `catch` answers `500 "Ocurrió un error al procesar la
 * petición."`. That is right for a failure nobody predicted and wrong for a
 * request that was simply not valid: `POST /api/obs` with a criticality of 12,
 * or a city with no coordinates, is the caller's own body coming back as a
 * broken server. Measured before this was written — both cases answered 500.
 *
 * **Why the column names are said out loud, when `generador.controller.ts`
 * deliberately does not.** There the caller sends a filter path and the columns
 * behind it are join targets it never named, so echoing them would hand back
 * the physical schema. Here they are words the client wrote: the body of a
 * create is mapped onto the row one name at a time, so `lat`, `id_tipoObs` and
 * `criticality` come straight back from the JSON the browser just sent.
 *
 * The exception, and it is small: two creates write nested rows whose columns
 * the caller never typed — `createEvento` maps `obs_ids` onto
 * `evento_obs.{id_obs, id_evento}` and `createPoste` maps `adss_ids` onto
 * `adss_poste.{id_adss, id_poste}`. Those are pivot tables of ids the request
 * did send, under names it did not, so the worst case is a column name that
 * reads oddly rather than a fact about the schema that was hidden. Only the
 * validation branch can name anything at all, and neither pivot has a
 * `validate:` block or a NOT NULL the parent does not already fill.
 *
 * The one exception is the unique violation, which names nothing. Not for
 * schema reasons — for enumeration: "ya existe un registro con ese correo" is a
 * way to ask whether an address has an account. The controllers that need to be
 * specific about a clash already are, with their own sentence and their own 409
 * (`usuario.controller.ts` for the username); this is only the floor under them.
 *
 * Values never travel. `err.errors[*].value` is the value that failed
 * validation — a password too short to pass the length rule is still the
 * password — and `logger.ts` redacts it for exactly that reason; the same holds
 * on the way to the browser.
 */
function fallaDelQueLlama(error: unknown): FalloDelQueLlama | null {
  const err = error as FalloDeSequelize | null;
  if (!err || typeof err.name !== "string") return null;

  if (err.name === "SequelizeValidationError") {
    const items = Array.isArray(err.errors) ? err.errors : [];
    const nombre = (i: { path?: string | null }) => (typeof i.path === "string" ? i.path : "");
    const faltan = [...new Set(items.filter((i) => (i.type ?? "").startsWith("notNull")).map(nombre).filter(Boolean))];
    const invalidos = [...new Set(items.filter((i) => !(i.type ?? "").startsWith("notNull")).map(nombre).filter(Boolean))];
    const frases: string[] = [];
    if (faltan.length > 0) frases.push(`Faltan datos obligatorios: ${faltan.join(", ")}.`);
    if (invalidos.length > 0) frases.push(`Alguno de los datos no es válido: ${invalidos.join(", ")}.`);
    return {
      status: 400,
      // A `ValidationError` with no readable items is still the caller's fault,
      // so it keeps the 400 and loses only the detail.
      message: frases.length > 0 ? frases.join(" ") : "Alguno de los datos enviados no es válido.",
    };
  }

  if (err.name === "SequelizeForeignKeyConstraintError") {
    // **The sentence stays generic, and that is measured rather than chosen.**
    // The first version of this named the offending column off `err.fields`.
    // On Postgres it never could: `dialects/postgres/query.js` builds the
    // 23503 error with `fields: null` hard-coded, whatever the constraint was,
    // so the branch was dead and the test that covered it hand-built a shape
    // the driver cannot produce. The column is recoverable from `err.index`
    // (the constraint name) if it is ever worth the extra guesswork.
    //
    // Note also what this does NOT distinguish. A foreign key breaks two ways:
    // pointing at a row that is not there — the caller's fault, a 400 — and
    // deleting a row something still references, which is a 409. Only the first
    // can happen through these routes today: the ten archives are soft deletes,
    // i.e. UPDATEs. But hard deletes do exist behind this same wrapper
    // (`deleteCredential`, `deleteTotp`, `endSession`, `putPermisos`, on the ten
    // models with no `paranoid`), so the day one of those gains a child table
    // with ON DELETE RESTRICT, this answers 400 for what is really a conflict.
    return { status: 400, message: "Uno de los datos relacionados no existe." };
  }

  if (err.name === "SequelizeUniqueConstraintError") {
    return { status: 409, message: "Ya existe un registro con esos datos." };
  }

  if (err.name === "SequelizeDatabaseError" && esExcepcionDeDatos(err.parent?.code ?? err.original?.code)) {
    return { status: 400, message: "Alguno de los valores no tiene el formato correcto." };
  }

  return null;
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
        const delQueLlama = fallaDelQueLlama(err);
        if (delQueLlama) {
          // `warn` and not `error`: the request was wrong, the server was not.
          // Filing these under `error` is how an error log stops meaning
          // anything — a missing field is not an incident, and it must not sit
          // in the same bucket as the ones that are.
          log.warn({ err, ruta: req.originalUrl }, `petición rechazada en ${name}`);
          if (!res.headersSent) {
            res.status(delQueLlama.status).json({ message: delQueLlama.message });
          }
          return;
        }
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
