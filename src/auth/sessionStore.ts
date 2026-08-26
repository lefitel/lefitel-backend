import { Op, type Transaction, type WhereOptions } from "sequelize";
import { SesionModel } from "../models/sesion.model.js";
import { newSessionToken, hashSessionToken } from "./sessionToken.js";
import {
  SESSION_IDLE_DAYS,
  SESSION_ABSOLUTE_DAYS,
  SESSION_USER_AGENT_MAX,
  SESSION_IP_MAX,
} from "../config/security.js";
import type { ISesion } from "../interfaces/index.js";
import type { EstadoSesion } from "./sessionState.js";

const DAY_MS = 86_400_000;

/**
 * `user_agent` is `STRING(SESSION_USER_AGENT_MAX)`. Browsers send strings far
 * longer than that, and Postgres does not truncate an oversized value to fit
 * its column — it rejects the whole insert with error 22001 — so the cut
 * happens here, before the row is written, instead of at the database.
 */
function fitUserAgent(ua?: string): string | null {
  if (!ua) return null;
  return ua.slice(0, SESSION_USER_AGENT_MAX);
}

/**
 * `ip_address` is `STRING(SESSION_IP_MAX)` — enough for exactly one IPv6
 * address.
 *
 * With `trust proxy` set to one hop (see `app.ts`), Express already resolves
 * `req.ip` to a single address rather than the raw `X-Forwarded-For` chain —
 * so today this rarely has anything to do. It stays as defense in depth
 * against that configuration changing: if a comma-separated chain of hops
 * ever does reach here, the first segment — the hop closest to the client —
 * is what a session list should show, so that is what is kept, rather than
 * an arbitrary `SESSION_IP_MAX`-character prefix that could cut the chain
 * mid-address and store something nobody would recognize as their session.
 */
function fitIp(ip?: string): string | null {
  if (!ip) return null;
  const first = ip.split(",")[0].trim();
  return first.slice(0, SESSION_IP_MAX);
}

/**
 * Open a session and return the token that names it.
 *
 * The token is returned once and never again: what the table keeps is its
 * hash, so nothing here or in a database dump can be replayed as a login.
 *
 * `id` is not set here: the column's own `DataTypes.UUIDV4` default (see
 * `sesion.model.ts`) generates it, so there is exactly one place that does.
 */
export async function createSession(
  id_usuario: number,
  meta: { userAgent?: string; ip?: string },
  // No default. A default here would be a policy decision taken by the
  // storage layer, and whichever value it took would be wrong somewhere:
  // `completa` hands a fresh password-only login the whole ERP, and `parcial`
  // locks out every caller that has legitimately finished. Making it
  // mandatory turns "which state does this login deserve" into a question the
  // compiler asks at each of the call sites, where the answer is known.
  estado: EstadoSesion,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_DAYS * DAY_MS);

  await SesionModel.create({
    id_usuario,
    token_hash: hashSessionToken(token),
    user_agent: fitUserAgent(meta.userAgent),
    ip_address: fitIp(meta.ip),
    created_at: now,
    last_used_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    estado,
  });

  return { token, expiresAt };
}

/**
 * The session this token names, if it is still good for anything.
 *
 * Three conditions, and all three have to be in the query rather than checked
 * afterwards: a revoked session, an expired one, and one past the absolute
 * ceiling are all "no". Checking them in JavaScript after the fact is how one
 * of them ends up forgotten on a later edit.
 */
export async function findLiveSession(token: string): Promise<{
  id: string;
  id_usuario: number;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date;
  estado: EstadoSesion;
  mfa_satisfied_at: Date | null;
  mfa_source: string | null;
} | null> {
  const now = new Date();
  const found = await SesionModel.findOne({
    where: {
      token_hash: hashSessionToken(token),
      revoked_at: null,
      expires_at: { [Op.gt]: now },
      created_at: { [Op.gt]: new Date(now.getTime() - SESSION_ABSOLUTE_DAYS * DAY_MS) },
    },
    attributes: [
      "id",
      "id_usuario",
      "created_at",
      "expires_at",
      "last_used_at",
      "estado",
      "mfa_satisfied_at",
      "mfa_source",
    ],
  });
  if (!found) return null;
  const v = found.dataValues;
  return {
    id: v.id,
    id_usuario: v.id_usuario,
    created_at: v.created_at,
    expires_at: v.expires_at,
    last_used_at: v.last_used_at,
    estado: v.estado,
    mfa_satisfied_at: v.mfa_satisfied_at,
    mfa_source: v.mfa_source,
  };
}

/**
 * `candidate`, or the day this session stops being honoured whatever happens,
 * whichever comes first.
 *
 * The ceiling is `SESSION_ABSOLUTE_DAYS` from the session's own `createdAt`,
 * and it is the second of the two conditions `findLiveSession` puts in its
 * query. So anything that tells a browser, a cookie or a response header when
 * a session dies has to go through here: without it the answer can be later
 * than the moment the server itself will start refusing the row, and every
 * countdown built on that answer is counting to the wrong instant.
 *
 * Exported because two different candidates need capping. `slidingExpiry`
 * below caps the idle window it is about to write; `authenticate` caps the
 * `expires_at` a row *already* holds, which it did not write and cannot
 * assume was capped — rows touched before this cap existed are uncapped for
 * up to thirty days after this deploys.
 */
export function cappedByCeiling(createdAt: Date, candidate: Date): Date {
  const ceiling = createdAt.getTime() + SESSION_ABSOLUTE_DAYS * DAY_MS;
  return new Date(Math.min(candidate.getTime(), ceiling));
}

/**
 * How far a cookie may say a session is good for, measured from `at`.
 *
 * The idle window pushed forward from `at`, capped at the absolute ceiling
 * measured from this session's own `createdAt`. Without the cap, a cookie
 * reissued on every touch would slide forever and the thirty-day ceiling
 * `findLiveSession` enforces would never be the reason a browser actually
 * drops it — the row would already be dead server-side for up to twenty-
 * three days before the browser noticed.
 */
export function slidingExpiry(createdAt: Date, at: Date): Date {
  return cappedByCeiling(createdAt, new Date(at.getTime() + SESSION_IDLE_DAYS * DAY_MS));
}

/**
 * Push the idle expiry back, and record that the session was used.
 *
 * `createdAt` is a parameter rather than something this function could do
 * without, and that is the fix for a real defect: this used to write a bare
 * `at + SESSION_IDLE_DAYS` with no ceiling applied, so from day twenty-three
 * of a session that is used every day the row claimed an `expires_at` later
 * than the day `findLiveSession` starts refusing it — by up to a full week.
 * Nothing could be got in with that row (`findLiveSession` checks the ceiling
 * against `created_at` separately, so the session never actually outlived its
 * thirty days), but the value is *read*: `GET /api/auth/sessions` renders it
 * on the profile screen, and `purgeExpiredSessions` carries a whole branch to
 * compensate for rows whose `expires_at` outran the ceiling.
 *
 * Taking `createdAt` and going through `slidingExpiry` means no caller can
 * write an uncapped expiry here again, which taking the finished date as a
 * parameter would not prevent. `authenticate` computes the same value for the
 * cookie and the response header from the same two arguments, and
 * `slidingExpiry` is pure, so all three carry the same instant.
 */
export async function touchSession(id: string, at: Date, createdAt: Date): Promise<void> {
  await SesionModel.update(
    { last_used_at: at, expires_at: slidingExpiry(createdAt, at) },
    { where: { id } },
  );
}

/**
 * End one session, and there is no version of this that does not name its owner.
 *
 * There used to be a `revokeSession(id)` beside this, with no `id_usuario` in
 * its `where`. Its only caller was `logout`, which has the owner in scope, so it
 * was correct everywhere it was used — and it was a loaded gun in a shared
 * module: the next person who needs to close a session, reaching for the
 * shorter name with an id that came out of a request, reintroduces exactly the
 * IDOR this plan was written to close. So there is one way to revoke, and the
 * owner is not optional in it.
 *
 * Marked rather than deleted, so the profile screen can show that a session
 * ended and when, and so an audit can see it happened at all. The
 * `revoked_at: null` guard makes a second call a no-op instead of overwriting
 * the original revocation time with a later one.
 *
 * The `id_usuario` in the `where` is the whole function. `DELETE
 * /api/auth/sessions/:id` takes the id from the URL, which is the caller's to
 * write, so without it any account with a session could close anybody else's —
 * and this repository has already shipped one `:id` route that trusted the URL
 * (any authenticated user could make themselves an administrator). The filter
 * lives in the query rather than in a check before it, so there is no read to
 * forget and no window between reading and writing.
 *
 * Returns whether a row was actually ended, which is what lets the endpoint
 * answer 404 for "not yours", "does not exist" and "already closed" with the
 * same words. A 403 would confirm the row exists and belongs to somebody.
 */
export async function revokeSessionOf(id_usuario: number, id: string): Promise<boolean> {
  const [count] = await SesionModel.update(
    { revoked_at: new Date() },
    { where: { id, id_usuario, revoked_at: null } },
  );
  return count > 0;
}

/**
 * End every live session of one person. Returns how many were ended.
 *
 * `except` spares one session, and it exists for exactly one case: somebody
 * changing their own password must not be thrown out of the browser they
 * changed it from. Everything else — an administrator resetting somebody
 * else's password, archiving an account, `POST /api/auth/logout-all` — passes
 * nothing and ends them all.
 *
 * The truthiness check is load-bearing, not sloppiness. Written as `if
 * ("except" in options)` the clause would become `id != NULL`, which in SQL is
 * never true, so the update would match **nothing** and the password change
 * would revoke no sessions at all — the failure this whole function exists to
 * prevent, arriving silently. Undefined and empty mean "spare nothing".
 *
 * `undefined` really does arrive, so that is not a defensive hypothetical:
 * `changePassword` passes `isSelf ? loggedUser.id_sesion : undefined`, so every
 * administrator resetting somebody else's password takes this branch, and
 * `deleteUsuario` passes no options at all. What used to reach it *by accident*
 * was a request on the old JWT path, which had no session row and therefore an
 * `undefined` `req.user.id_sesion`; that credential is retired and
 * `req.user.id_sesion` is now always a real id.
 *
 * `transaction` is here for `deleteUsuario`, which archives an account and ends
 * its sessions and must not be able to do one without the other.
 */
export async function revokeAllSessionsOf(
  id_usuario: number,
  options: { except?: string; transaction?: Transaction } = {},
): Promise<number> {
  const where: WhereOptions<ISesion> = options.except
    ? { id_usuario, revoked_at: null, id: { [Op.ne]: options.except } }
    : { id_usuario, revoked_at: null };
  const [count] = await SesionModel.update(
    { revoked_at: new Date() },
    { where, transaction: options.transaction },
  );
  return count;
}

/**
 * The sessions a person could still be using, newest first.
 *
 * `token_hash` is excluded even though nothing can be done with a SHA-256 of
 * a 256-bit token: this list is what the profile screen renders, i.e. a
 * `res.json`, and the whole point of this module is that the hash never
 * leaves the database — an unreachable `attributes` bug later should not be
 * the first thing standing in the way of that.
 *
 * The same three conditions as `findLiveSession` — revoked, expired, and past
 * the absolute ceiling — for the same reason: this is a second query
 * deciding the same question, "is this session still good for anything", and
 * the ceiling is exactly the condition a later edit forgets. Without it, a
 * device already refused by `findLiveSession` still showed up here as
 * connected — the one place a person checks after losing a laptop, telling
 * them a risk is still open when it no longer is, or the other way round.
 */
export async function listSessionsOf(id_usuario: number): Promise<Omit<ISesion, "token_hash">[]> {
  const now = new Date();
  const rows = await SesionModel.findAll({
    where: {
      id_usuario,
      revoked_at: null,
      expires_at: { [Op.gt]: now },
      created_at: { [Op.gt]: new Date(now.getTime() - SESSION_ABSOLUTE_DAYS * DAY_MS) },
    },
    attributes: { exclude: ["token_hash"] },
    order: [["last_used_at", "DESC"]],
  });
  return rows.map((r) => r.dataValues);
}

/**
 * Delete rows that cannot matter to anyone any more.
 *
 * Nothing else deletes from this table, so without this it only grows. Three
 * ways for a row to reach that state: its idle expiry passed without being
 * renewed, it was revoked, or it was created past the absolute ceiling. That
 * last branch matters on its own — a session touched right up to the ceiling
 * keeps pushing `expires_at` forward on every use, so it can outlive the
 * ceiling by `expires_at` alone, even though `findLiveSession` has already
 * been refusing it since the moment it crossed `created_at`.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - SESSION_ABSOLUTE_DAYS * DAY_MS);
  return SesionModel.destroy({
    where: {
      [Op.or]: [
        { expires_at: { [Op.lt]: cutoff } },
        { revoked_at: { [Op.lt]: cutoff } },
        { created_at: { [Op.lt]: cutoff } },
      ],
    },
  });
}
