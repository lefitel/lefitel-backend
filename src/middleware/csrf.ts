// CSRF: the two things a cookie-authenticated write has to prove.
//
// Why this file exists at all is the switch from a header to a cookie. With
// `Authorization: Bearer` there was nothing here to defend: a browser never
// attaches that header on its own, so a page on somebody else's site could make
// this API answer but never make it answer *as somebody*. A cookie is attached
// automatically, which is the whole convenience of it and the whole problem:
// evil.example can put a form on a page, and the victim's browser submits it
// with the victim's session. The cookie is now the only credential this API
// accepts, so every authenticated write in the product is a write this guard
// has to cover.
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
// **Keyed on the cookie, and on nothing else.** This runs only on a request that
// carries a session cookie, and a write without one is waved through because
// there is nothing of the victim's for another site to abuse — `authenticate`
// refuses it a moment later anyway, for having no credential at all.
//
// That rule was written when a second credential existed, and the version of it
// that was rejected is worth keeping written down: keying on "a cookie and no
// `Authorization` header" looks equivalent and is not. A request carrying both
// was a cookie-authenticated request — `authenticate` read the cookie first and
// never fell back — so a rule that waved it through would have protected
// nothing from an attacker who simply attached a meaningless `Authorization`
// header to the forged form. `Authorization` no longer authenticates anything,
// which makes that bypass cheaper rather than dearer to attempt: the header is
// now free to send and means nothing, so nothing about this decision may ever
// look at it. `csrf.test.ts` pins both halves — a cookie write is still guarded
// with the header present, and a header alone still opens nothing.
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
//
// Covering the login by the ordinary rule means a *second* login — one made
// with a cookie already in hand — can be refused by it too, and a refusal
// there is not like a refusal anywhere else: it can block the very request
// that would replace a broken cookie with a working one. See `refuse()` below
// for why a header-refusal clears the cookie rather than leaving that trap in
// place.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { clearSessionCookie, readSessionCookie } from "../auth/sessionCookie.js";
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
      // the bypass. Nothing legitimate is lost today — the one client that
      // authenticates by cookie is a browser talking to a different host from the
      // one that served it the page, and every such cross-origin request, made in
      // CORS mode, names its origin.
      //
      // That is not quite "a browser always names its origin on a request that
      // carries a body", which is what this comment used to claim. Per the Fetch
      // standard, a *same-origin* non-GET request can still send `Origin: null`
      // when the page's `Referrer-Policy` is `no-referrer` or `same-origin`. Not
      // reachable here — the frontend is a different origin from the API and sets
      // no referrer policy of its own — but if `/api` were ever proxied onto the
      // frontend's own origin, such a policy would 403 every write with no
      // attacker involved. Worth knowing as a trap, not as a hole: it fails
      // closed, which is a bad afternoon and not a session handed over.
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
 *
 * **Why a refusal for a missing header also takes the cookie back, and a
 * refusal for a bad origin does not.**
 *
 * `POST /api/login` reads the cookie too — `issueSession` calls `rotateOut`,
 * which revokes the session it names — so this guard applies to it exactly
 * like any other write, with no route carved out. That is correct, and it
 * opened a lockout the previous version of this task did not name: the
 * comment on `PETICION_NO_VERIFICABLE` already admits the realistic causes of
 * a refusal are "a stale bundle and a proxy that strips headers it does not
 * recognise" — both of which drop the custom header, not the `Origin` a
 * browser sets itself. When that happens to a browser that already holds a
 * cookie, every write 403s, *including the login that would replace the
 * cookie with a working one*.
 *
 * The obvious escape is logging out, and it is not one. The frontend does now
 * call `POST /api/auth/logout` (`SesionProvider.tsx`) — it did not when this
 * was first written, and the reason given here used to be that it never did —
 * but that call is itself a cookie-carrying write, so it arrives at this same
 * guard missing the same header and is refused with the same 403 as
 * everything else. The change of premise makes this decision *more*
 * necessary, not less: there is no request the application can make that
 * discards this cookie, and "reload the page" — the only advice this response
 * gives — does nothing, because the same cookie comes back on the retry and
 * is refused again. A user in this state was stuck until they cleared cookies
 * by hand.
 *
 * Two ways to close it were on the table. One: carve out `POST /api/login`
 * from the header requirement, leaving only the `Origin` check on it. Two:
 * have a header-refusal also clear the cookie, so the very next request —
 * whichever route it hits — arrives with none, and this guard's first line
 * (`if (!readSessionCookie(req)) return next()`) waves it through. Taken here,
 * because it leaves the caller in a clean, retryable state instead of writing
 * a permanent, route-specific exception into a rule whose entire point was
 * having none. It costs nothing legitimate: `SameSite=Lax` already stops a
 * cross-*site* request from carrying this cookie at all, so nothing outside
 * osefi.net can trigger this refusal to force a logout, and the only thing
 * clearing this cookie can ever do to a *following* request is remove a
 * credential — never add one.
 *
 * It stays off a bad-`Origin` refusal on purpose, even though the mechanism
 * would work there too. The two comment-named causes above both produce a
 * missing header with a *correct* `Origin` — a script cannot forge `Origin`,
 * so the only way to reach this app's own origin in that header is to already
 * be a request from it. A bad-`Origin` refusal is a different situation: it
 * can be triggered from `evil.osefi.net`, a same-site subdomain `SameSite=Lax`
 * does not stop, and clearing the cookie there would hand that subdomain a
 * free, repeatable way to log any visitor out — a real capability gained for
 * a lockout that was never reachable through this path in the first place.
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
  if (motivo === "cabecera") {
    clearSessionCookie(res);
  }
  res.status(403).json({ message: PETICION_NO_VERIFICABLE });
}
