// CSRF: the two things a cookie-authenticated write has to prove.
//
// With `Authorization: Bearer` there was nothing here to defend. A browser never
// attaches that header on its own, so a page on somebody else's site could make
// this API answer but never make it answer *as somebody*. A cookie is attached
// automatically, which is the whole convenience of it and the whole problem:
// evil.example can put a form on a page, and the victim's browser submits it
// with the victim's session.
//
// Two barriers, and neither is the other's spare:
//
//  1. `Origin` against an exact list, checked here. It does not depend on the
//     browser behaving well: whatever the request claims, the string either is
//     one of ours or it is not.
//  2. A header of our own on every write. A request header that is not
//     CORS-safelisted forces the browser to ask permission before it sends
//     anything at all, and the only origins this API grants that permission to
//     are the same list.
//
// Barrier 1 judges the request that arrives. Barrier 2 exists because of the
// class of request that needs no permission to arrive: an HTML form post carries
// `application/x-www-form-urlencoded` or `multipart/form-data`, both
// CORS-safelisted, so there is no preflight to refuse and the browser sends it
// whatever this server would have said. `POST /api/upload` takes multipart and
// was exactly that shape. Barrier 1 does read the `Origin` such a form sends, so
// the two overlap there — and they stop overlapping wherever a header is dropped
// in transit, or the day a future `express.urlencoded()` makes a form body
// meaningful.
//
// What is *not* a barrier: `SameSite=Lax`. It stops cross-*site* requests, and a
// subdomain is not cross-site. Against evil.osefi.net — one mis-delegated DNS
// record, or one abandoned staging host, away — these two are the only things
// standing, which is why neither is written here as the other's backup.
//
// ─────────────────────────────────────────────────────────────────────────────
// **The rule that lets both credentials live at once.** This runs only on a
// request that carries a session cookie. A request authenticated by the old
// bearer token does not need it: nothing makes a browser send `Authorization` by
// itself, so there is nothing for another site to trigger. Demanding the header
// from everything would refuse every write the current frontend makes, since it
// sends no header of its own — and being able to deploy the two halves on
// different days is the entire reason the two credentials coexist.
//
// Keyed on the cookie, and not on "a cookie and no bearer", which looks
// equivalent and is not. `authenticate` reads the cookie first and never falls
// back, so a request carrying both *is* a cookie-authenticated request; a rule
// that waved it through would protect nothing from the day the frontend sends
// both — which is the day this lands, because the frontend attaches a bearer
// token to every call it makes.
//
// ─────────────────────────────────────────────────────────────────────────────
// **The login is not an exception, and it used to be justified as one.** The
// reasoning written down in the previous task was that `POST /auth/login`
// arrives without a cookie, so the rule skips it by construction. That stopped
// being true when the login started rotating the session: `issueSession` calls
// `rotateOut`, which reads the cookie and revokes the row it names. So the login
// does read the credential, and a request that destroys a session on the
// strength of a cookie is exactly the kind of write this check is for. It is
// covered by the ordinary rule, and nothing is carved out for it.
//
// A browser's *first* login still passes unchecked, because there is no cookie
// yet and so nothing of the victim's to abuse. What keeps that from being login
// CSRF — another site making somebody's browser log in as the attacker, so that
// whatever they type next lands in the attacker's account — is `cors()`: a JSON
// post needs a preflight, and this API grants one only to its own frontend. Not
// the body parser, which also happens to refuse the form-encoded post that needs
// no preflight, because `express.json()` leaves `req.body` empty and
// `verifyCredentials` answers 400 to a missing user. That is a real obstacle
// today and an accidental one, and it disappears the day somebody mounts
// `express.urlencoded()` for an unrelated reason.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { readSessionCookie } from "../auth/sessionCookie.js";
import { CSRF_CLIENT_HEADER, PETICION_NO_VERIFICABLE } from "../config/security.js";
import { log } from "../utils/logger.js";

const csrfLog = log("csrf");

/**
 * The methods that change something.
 *
 * Written out here rather than kept in `config/security.ts` with the tunable
 * numbers, because nobody deploys a different idea of which verbs write. And
 * `csrf.test.ts` writes the same verbs out again on its own side on purpose: a
 * test that imported this set would be asserting that this file agrees with
 * itself.
 */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Refuses a write that cannot show it came from our own frontend.
 *
 * Takes the origin list rather than reading the environment, so `app.ts` can
 * compute it once and hand the same array to `cors()` and to this. Two readings
 * of the same variable would still be two lists.
 *
 * The list becomes a `Set`, and that shape is part of the guarantee: `Set.has`
 * is string equality, and there is no way to loosen it into a prefix or a suffix
 * test without replacing the data structure. Suffix matching is how
 * `https://evil-osefi.net` passes a check written for `osefi.net`, and it reads
 * like a generous convenience right up to the moment it is a session handed over.
 */
export function requireSameOrigin(allowed: readonly string[]): RequestHandler {
  const permitted = new Set(allowed);

  // The name comes from the const binding, which `routeGuards.test.ts` reads off
  // the assembled app. The permission gates need `Object.defineProperty` for that
  // only because they go through a wrapper; nothing wraps this one.
  const sameOriginGate = (req: Request, res: Response, next: NextFunction): void => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    if (!readSessionCookie(req)) return next();

    const origin = req.headers.origin;
    if (typeof origin !== "string" || !permitted.has(origin)) {
      // Absent counts as refused, and that is the difference between a check and
      // a suggestion: if a missing header meant "allowed", stripping it would be
      // the bypass. Nothing legitimate is lost — the one client that
      // authenticates by cookie is a browser talking to a different host from the
      // one that served it the page, and a browser always names its origin on a
      // request that carries a body.
      return refuse(req, res, "origen", origin);
    }

    const client = req.headers[CSRF_CLIENT_HEADER];
    if (typeof client !== "string" || client.trim() === "") {
      return refuse(req, res, "cabecera", origin);
    }

    return next();
  };

  return sameOriginGate;
}

/**
 * One place that answers, and writes down which half failed.
 *
 * Through the request's own logger when there is one, so the refusal and the
 * request line carry the same id and read as one event — the same thing
 * `requirePermission` does.
 */
function refuse(
  req: Request,
  res: Response,
  motivo: "origen" | "cabecera",
  origin: string | undefined,
): void {
  const to = (req as Request & { log?: typeof csrfLog }).log ?? csrfLog;
  to.warn(
    { motivo, origin: origin ?? null, metodo: req.method, ruta: req.originalUrl },
    "escritura con cookie rechazada: no se pudo verificar el origen",
  );
  res.status(403).json({ message: PETICION_NO_VERIFICABLE });
}
