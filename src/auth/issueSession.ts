// Opening a session and handing it to the browser, in one place.
//
// Three things that always go together: the session this browser was already
// holding is closed, a new row is written, and the cookie that names it is put
// on the response. Written out at each call site they can be got partly right —
// a row created and no cookie set is a session nobody can use and nothing will
// clean up before the purge; a cookie set from a token that was never stored is
// a 401 on the very next request; and forgetting the first one is what left the
// sessions screen unreadable (see `rotateOut` below).
//
// Two callers, three addresses. `auth/finishLogin.ts`'s `terminarLogin`, which
// both the password login (`POST /api/auth/login` and the old `POST /api/login`,
// one handler) and the passwordless login (`POST /api/auth/webauthn/passwordless/verify`)
// go through; and `usuario.controller.ts`'s `changePassword`, which rotates the
// caller's own session after a password change. This used to say "one caller"
// — the old door's JWT handler was the second and is gone — and it stopped
// being true the day the password change started rotating; the cookie this
// opens is the only credential any of them hands out.

import type { Request, Response } from "express";
import type { Transaction } from "sequelize";
import { createSession, findLiveSession, revokeSessionOf } from "./sessionStore.js";
import { readSessionCookie, setSessionCookie } from "./sessionCookie.js";
import { SESSION_EXPIRES_HEADER } from "../config/security.js";
import type { EstadoSesion, FuenteEnElLogin } from "./sessionState.js";

/**
 * Open a session for this person and put it in the response as a cookie.
 *
 * Returns the row's id and nothing else, deliberately. The token exists for
 * exactly as long as this function runs and then only the browser has it — a
 * return value carrying it would be an invitation to put it in a response
 * body, which is the one thing the cookie was introduced to stop. The id is a
 * different thing: it names the row without opening it, `GET /auth/sessions`
 * already publishes it, and the bitácora line a login writes wants to say
 * which session it opened — the question worth asking after a credential is
 * found to be copied.
 *
 * `user_agent` and `ip` are read off the request here rather than passed in, so
 * the two callers cannot disagree about which header the session list shows.
 * `req.ip` respects `trust proxy` (set to one hop in `app.ts`), so it is the
 * client's address and not the Coolify proxy's.
 *
 * `estado` is mandatory, same reasoning and no default, one level up from
 * `createSession`'s own: this is the last place before the row is written
 * where the caller — the login — still knows what it just decided.
 *
 * **`SESSION_EXPIRES_HEADER` goes out beside the cookie, and it has to be set
 * here rather than left to `authenticate`.** That middleware is the only other
 * place that writes the header, and it computes the deadline from the session
 * the request arrived on — which, on a rotation, is the row the handler is
 * about to revoke. `updateUserPass` is the case: `authenticate` writes the old
 * session's remaining window early in the request, this function replaces the
 * cookie, and nothing recomputes the header. Bounded by `slidingExpiry`, so a
 * young session is harmless; a session at day twenty-nine reports **hours**
 * while the cookie it is handed is good for a week. The header's contract is
 * that a value means "reschedule on it", so the client takes the smaller
 * number and logs somebody out of a session opened seconds earlier — the exact
 * failure `authenticate`'s own comment says this header exists to prevent.
 *
 * The login now states its deadline too, which is a gain rather than a
 * surprise: the header is already exposed through CORS for the browser to read
 * (`app.ts`), `/auth/me`'s comment already tells clients to prefer it over the
 * body, and its documented contract is that absence means "no news" — so no
 * conforming client can be broken by receiving it. Until now the one response
 * that *creates* a deadline was the one response that never stated it.
 *
 * It does **not** follow that the countdown now arms at the login. `web`'s
 * `learnDeadline` returns early while `hasSessionRef` is false, and that ref
 * only becomes true after the login response has been handled — so today's
 * client discards this particular header and still arms on the first ordinary
 * response. Stated here rather than fixed: a client that wants the deadline at
 * the login can now have it, and the one we ship does not ask.
 *
 * No `cappedByCeiling` here, and none is needed: the row is new, so the
 * absolute ceiling is thirty days from this instant and the idle window is
 * seven. A fresh session cannot be capped by its own ceiling.
 */
export async function issueSession(
  req: Request,
  res: Response,
  id_usuario: number,
  estado: EstadoSesion,
  /** Passed straight through to `createSession` — see its own comment. */
  fuente?: FuenteEnElLogin,
  /**
   * The passwordless login's transaction, and every query here joins it —
   * `rotateOut`'s two included. Not for atomicity's sake: a transaction holds
   * one pool connection, and a query issued without it while the transaction
   * is open borrows a *second*; fifteen such logins at once, on a pool of
   * fifteen, would each hold one and wait for another until the acquire
   * timeout, for the whole API. So inside a transaction nothing may go around
   * it. The consequence for `rotateOut` is that a rollback leaves the previous
   * session alive — and that is the right outcome: the only rollback on that
   * path is a commit failure, which answers 500 and clears the cookie, so the
   * browser can no longer reach that row anyway, and nothing was changed by a
   * login that did not happen. The password door passes no transaction and
   * keeps its old shape: revoke first, autocommit, then create.
   */
  opciones: { transaction?: Transaction } = {},
): Promise<{ id: string }> {
  await rotateOut(req, opciones);
  const { token, expiresAt, id } = await createSession(
    id_usuario,
    {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    },
    estado,
    fuente,
    opciones,
  );
  setSessionCookie(res, token, expiresAt);
  res.setHeader(SESSION_EXPIRES_HEADER, expiresAt.toISOString());
  return { id };
}

/**
 * End the session this browser was already holding, before opening the next.
 *
 * Without this, logging in twice from the same browser leaves two live rows,
 * and nothing removes the first for seven days. The frontend does call `POST
 * /auth/logout` now — when this was written it did not, and this comment used
 * to say so — so a row is revoked from that side whenever somebody presses the
 * button. That is not most of the time: closing the tab revokes nothing, and a
 * logout the network lost is not retried on its own. `SesionProvider.tsx` does
 * announce that failure now — this comment used to say it was swallowed, and
 * that stopped being true one commit later — but announcing is not revoking:
 * the row stays live until a person acts on the notice. So an abandoned row per
 * login is still the normal outcome rather than the exception. Twenty people
 * entering one to three times a day, against sessions that live seven days, is
 * on the order of seven to twenty live rows per account, **every one of them
 * with the same `user_agent` and the same IP address**.
 *
 * Which lands squarely on this task's own deliverable. `GET /auth/sessions` is
 * the screen where somebody decides what to close, and it would show a column
 * of indistinguishable entries, not one of which corresponds to a browser
 * anybody is actually using. Meanwhile each abandoned token stays a working
 * credential for a week — the exact thing this plan exists to be able to
 * revoke.
 *
 * Rotating the session on login is also good practice on its own account, and
 * this is the only moment where the old credential and the new one are both in
 * hand.
 *
 * The row's owner is deliberately not compared against the person logging in.
 * Whoever it belonged to, its token lived in the cookie this response is about
 * to overwrite, so leaving the row live leaves a credential that cannot be
 * reached from this browser any more. In every real case it is the same person
 * entering again.
 */
async function rotateOut(req: Request, opciones: { transaction?: Transaction }): Promise<void> {
  const previous = readSessionCookie(req);
  if (!previous) return;
  const live = await findLiveSession(previous, opciones);
  if (!live) return;
  await revokeSessionOf(live.id_usuario, live.id, opciones);
}
