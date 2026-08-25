// The budget on `POST /api/upload/`.
//
// That endpoint is deliberately outside the permission matrix, and its router
// holds the argument: it serves an event photograph, a pole photograph and the
// portrait on your own profile, so tying it to one module would either stop a
// Cliente changing their own picture or hand a Cliente the right to attach
// photographs to events. That reasoning is sound and is not what changed.
//
// What changed is the other half of the sentence, which nobody had written:
// ungated *and* unmetered. Any valid session could write to the server's disk at
// five megabytes a request without limit, from the least-privileged role there
// is. The orphan sweep on the Archivos screen collects files that nothing points
// at, but it runs when a person opens that screen — housekeeping, not a brake.
//
// So the exemption from the matrix stays, and a budget takes its place. This is
// the shape the API already uses for the operations that cost something: the
// report builder meters its query, its count and its export separately, each
// against what it actually costs.

import rateLimit from "express-rate-limit";
import type { Request } from "express";

/** One minute. Short on purpose: this meters a burst, not a day's work. */
export const UPLOAD_WINDOW_MS = 60_000;

/**
 * Uploads per account per minute.
 *
 * Sized from the work rather than from the risk, because a budget that a real
 * shift trips is a budget somebody will remove. A technician registering events
 * in the field attaches one or two photographs per event; thirty a minute is one
 * every two seconds, sustained, which no hand does. It still turns "unlimited"
 * into a ceiling of 150 MB a minute per account, and an account is a thing an
 * administrator can suspend.
 */
export const UPLOAD_LIMIT = 30;

/**
 * The bucket an upload is charged to.
 *
 * The account, because that is what the session names and what somebody can act
 * on. The address is only the fallback for a request arriving without a session,
 * which `authenticate` already prevents on this mount — but a key generator that
 * returns `undefined` puts every anonymous caller into one shared bucket, and a
 * shared bucket is worse than a wrong one: the first stranger to spend it locks
 * out the rest.
 */
export const uploadBucketKey = (req: Request): string => {
  const id = (req as Request & { user?: { id?: number } }).user?.id;
  return id === undefined ? `upload:ip:${req.ip}` : `upload:u:${id}`;
};

export const uploadLimiter = rateLimit({
  windowMs: UPLOAD_WINDOW_MS,
  limit: UPLOAD_LIMIT,
  keyGenerator: uploadBucketKey,
  // `{ message }` is what every failure in this API answers with. A limiter
  // replying in any other shape surfaces as an undefined message on screen.
  message: { message: "Demasiadas imágenes seguidas. Espere un minuto antes de subir otra." },
  standardHeaders: true,
  legacyHeaders: false,
});
