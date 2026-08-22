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
export async function findLiveSession(
  token: string,
): Promise<{ id: string; id_usuario: number; expires_at: Date; last_used_at: Date } | null> {
  const now = new Date();
  const found = await SesionModel.findOne({
    where: {
      token_hash: hashSessionToken(token),
      revoked_at: null,
      expires_at: { [Op.gt]: now },
      created_at: { [Op.gt]: new Date(now.getTime() - SESSION_ABSOLUTE_DAYS * DAY_MS) },
    },
    attributes: ["id", "id_usuario", "expires_at", "last_used_at"],
  });
  if (!found) return null;
  const v = found.dataValues;
  return {
    id: v.id,
    id_usuario: v.id_usuario,
    expires_at: v.expires_at,
    last_used_at: v.last_used_at,
  };
}

/** Push the idle expiry back, and record that the session was used. */
export async function touchSession(id: string, at: Date): Promise<void> {
  await SesionModel.update(
    { last_used_at: at, expires_at: new Date(at.getTime() + SESSION_IDLE_DAYS * DAY_MS) },
    { where: { id } },
  );
}

/**
 * End one session.
 *
 * Marked rather than deleted, so the profile screen can show that it ended and
 * when, and so an audit can see it happened at all. The `revoked_at: null`
 * guard makes a second call a no-op instead of overwriting the original
 * revocation time with a later one.
 */
export async function revokeSession(id: string): Promise<void> {
  await SesionModel.update({ revoked_at: new Date() }, { where: { id, revoked_at: null } });
}

/**
 * End one session, but only if it belongs to this person.
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
 * The truthiness check is load-bearing, not sloppiness. A request that arrived
 * on the old JWT path has no session row, so `req.user.id_sesion` is
 * `undefined`, and callers pass it straight through. Written as `if ("except"
 * in options)` the clause would become `id != NULL`, which in SQL is never
 * true, so the update would match **nothing** and the password change would
 * revoke no sessions at all — the failure this whole function exists to
 * prevent, arriving silently. Undefined and empty mean "spare nothing".
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
 */
export async function listSessionsOf(id_usuario: number): Promise<Omit<ISesion, "token_hash">[]> {
  const rows = await SesionModel.findAll({
    where: { id_usuario, revoked_at: null, expires_at: { [Op.gt]: new Date() } },
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
