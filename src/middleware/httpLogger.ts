import { pinoHttp } from "pino-http";
import type { Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

/**
 * One line per request, and a thread to pull on.
 *
 * `morgan("dev")` printed the method, the path and the status. That is enough
 * when one person is using the server and useless when several are: their lines
 * interleave and nothing says which is which. Every request now carries an id,
 * and everything logged while handling it carries the same one — so a complaint
 * about one save becomes a filter, not a reading exercise.
 *
 * The id comes from the proxy when there is one. Some proxies and load balancers
 * set `x-request-id`, and reusing it means the server's line and the platform's
 * line for the same request can be matched up.
 */

/**
 * The path as the caller typed it.
 *
 * Inside a mounted router Express rewrites `req.url` to the part after the
 * mount, so a request to `/api/login` arrives at the handler as `/`. Reading it
 * without `originalUrl` produced lines saying `GET / → 401`, which is the one
 * piece of information the line existed to carry.
 */
const fullUrl = (req: IncomingMessage): string =>
  (req as Request).originalUrl ?? req.url ?? "";

/** Requests not worth a line each. */
function isNoise(req: Request): boolean {
  // Images are served straight off disk by express.static; a page with fifty
  // photographs would otherwise bury everything else in the log.
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|map)$/i.test(fullUrl(req).split("?")[0])) return true;
  return false;
}

export const httpLogger = pinoHttp({
  logger,

  genReqId: (req, res) => {
    const fromProxy = req.headers["x-request-id"];
    const id = (Array.isArray(fromProxy) ? fromProxy[0] : fromProxy) ?? randomUUID().slice(0, 8);
    res.setHeader("x-request-id", id);
    return id;
  },

  /**
   * The status decides, not whether an error object exists.
   *
   * A 4xx is the server working correctly — a permission refused, a malformed
   * body rejected — and body-parser reports those by throwing, so keying off
   * the error made every client mistake an `error`. Reserve that level for the
   * failures that are ours, or nobody reads them.
   */
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return err ? "error" : "info";
  },

  customSuccessMessage: (req, res) => `${req.method} ${fullUrl(req)} → ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${fullUrl(req)} → ${res.statusCode} (${err.message})`,

  /**
   * Who was asking.
   *
   * `authenticateToken` has run by the time a response is logged, so the session
   * is available — and it is the single most useful thing to have on the line
   * when somebody reports a problem, because it turns "a user" into "user 14".
   */
  customProps: (req) => {
    const user = (req as Request).user;
    return user ? { usuario: user.id, rol: user.id_rol } : {};
  },

  autoLogging: { ignore: (req) => isNoise(req as Request) },

  // Trimmed on purpose. The full header set is several hundred bytes of
  // nothing per request, and the interesting ones are named explicitly.
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: fullUrl(req as unknown as IncomingMessage),
      ip: req.remoteAddress,
    }),
    res: (res: Response) => ({ statusCode: res.statusCode }),

    /**
     * A stack trace for somebody else's mistake is noise.
     *
     * Malformed JSON and oversized bodies arrive as thrown errors carrying a
     * `statusCode` in the 400s. Ten frames of body-parser internals say nothing
     * about them and bury the errors that are actually ours.
     */
    err: (err: Error & { statusCode?: number; status?: number }) => {
      const status = err.statusCode ?? err.status ?? 500;
      const base = { type: err.name, message: err.message, statusCode: status };
      return status >= 500 ? { ...base, stack: err.stack } : base;
    },
  },
});
