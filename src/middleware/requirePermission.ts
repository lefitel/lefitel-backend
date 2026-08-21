import { Request, Response, NextFunction } from "express";
import { can } from "../permissions/store.js";
import type { Action, Module } from "../permissions/matrix.js";
import { log } from "../utils/logger.js";

const gateLog = log("permisos");

/**
 * Answers 500 instead of letting the process die.
 *
 * These gates are `async`, and Express 4 only catches what a handler throws
 * *synchronously*: a returned promise that rejects is dropped on the floor, and
 * Node's default for an unhandled rejection is to terminate. So any failure of
 * the permissions query — a lost connection, an exhausted pool — did not answer
 * 403 or 500, it took the whole API down, from any account with a session. The
 * matrix is cached behind a single in-flight promise, so one failed load
 * rejected every concurrent check at once.
 *
 * Failing closed is the only safe direction: if we cannot find out what this
 * role may do, the answer is no.
 */
function fromPromise(
  gate: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) =>
    gate(req, res, next).catch((error: unknown) => {
      // Through the request's own logger when there is one, so the cause and
      // the request line carry the same id and can be read as one event.
      const to = (req as Request & { log?: typeof gateLog }).log ?? gateLog;
      to.error({ err: error, url: req.originalUrl }, "no se pudo comprobar el permiso");
      if (!res.headersSent) {
        res.status(500).json({ message: "No se pudo comprobar su permiso. Intente de nuevo." });
      }
      // Express ignores what a handler returns, but the tests await this — and
      // a promise that settles when the gate is done beats one that settles a
      // microtask earlier and happens to work.
    });
}

/**
 * Server-side permission check.
 *
 * The interface has always known what each role may do — the matrix lived in
 * `web/src/lib/permissions.ts` and decided which buttons to draw. But a decision
 * taken in the browser is a suggestion: the code runs on the caller's machine
 * and the caller can ignore it. Every write endpoint was open to any account
 * with a session, whatever its role.
 *
 * This is that same matrix, asked on the server, where the answer is binding.
 *
 * Must run after authenticateToken, which is what populates req.user — and
 * `authenticateToken` re-reads the role from the database on every request, so
 * revoking a permission takes effect without waiting for anyone to log out.
 */
export function requirePermission(modulo: Module, accion: Action) {
  // Named, not anonymous: routeGuards.test.ts reads these names off the mounted
  // app to tell a gated route from an open one. The name has to survive the
  // wrapper, so the wrapped function is the one that carries it.
  const requirePermissionGate = async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.id_rol;
    if (role === undefined) return res.sendStatus(401);

    if (await can(role, modulo, accion)) return next();
    return res.status(403).json({ message: "No tiene permiso para realizar esta acción." });
  };
  return Object.defineProperty(fromPromise(requirePermissionGate), "name", {
    value: "requirePermissionGate",
  });
}

/**
 * Lets a person act on their own record, and anyone holding the permission act
 * on any record.
 *
 * Ownership is not a role permission and deliberately has no checkbox: the same
 * endpoints serve two purposes. `GET /usuario/:id` is how the profile page loads
 * whoever is logged in, and also how administration inspects anyone. Locking the
 * route to the Seguridad module would stop people reading their own profile or
 * changing their own password; leaving it open hands out the staff directory.
 *
 * So the two questions stay separate: the matrix answers "what may this role do
 * to other people's rows", and this answers "is this your own row".
 *
 * `param` names the route parameter holding the user id. It defaults to "id",
 * but the bitácora route calls it `:id_usuario` — and the old version of this
 * middleware read "id" unconditionally, so on that route the ownership check
 * compared against `undefined` and never matched. "A user may review their own
 * activity" has been a comment describing a 403 ever since it was written.
 */
export function requireSelfOrPermission(modulo: Module, accion: Action, param = "id") {
  const requireSelfOrPermissionGate = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const role = req.user?.id_rol;
    if (role === undefined) return res.sendStatus(401);
    if (await can(role, modulo, accion)) return next();

    const value = req.params[param];
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw !== undefined && Number(raw) === req.user?.id) return next();

    return res.status(403).json({ message: "Solo puede consultar o modificar su propio usuario." });
  };
  return Object.defineProperty(fromPromise(requireSelfOrPermissionGate), "name", {
    value: "requireSelfOrPermissionGate",
  });
}
