import { Op } from "sequelize";
import { randomUUID } from "node:crypto";
import { SesionModel } from "../models/sesion.model.js";
import { newSessionToken, hashSessionToken } from "./sessionToken.js";
import {
  SESSION_IDLE_DAYS,
  SESSION_ABSOLUTE_DAYS,
} from "../config/security.js";
import type { ISesion } from "../interfaces/index.js";

const DAY_MS = 86_400_000;

/**
 * `user_agent` is STRING(255). Browsers send strings far longer than that,
 * and Postgres does not truncate an oversized value to fit its column — it
 * rejects the whole insert with error 22001 — so the cut happens here,
 * before the row is written, instead of at the database.
 */
function fitUserAgent(ua?: string): string | null {
  if (!ua) return null;
  return ua.slice(0, 255);
}

/**
 * `ip_address` is STRING(45) — enough for exactly one IPv6 address, no more.
 *
 * This server runs behind a proxy with `trust proxy` on, and `X-Forwarded-For`
 * arrives as a comma-separated chain of every hop once there is more than
 * one, which can run well past 45 characters. Postgres does not truncate an
 * oversized value to fit its column here either — it rejects the insert with
 * the same error 22001 — so this is cut the same way `user_agent` is, rather
 * than trusted to already be one address.
 */
function fitIp(ip?: string): string | null {
  if (!ip) return null;
  return ip.slice(0, 45);
}

/**
 * Open a session and return the token that names it.
 *
 * The token is returned once and never again: what the table keeps is its
 * hash, so nothing here or in a database dump can be replayed as a login.
 */
export async function createSession(
  id_usuario: number,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_DAYS * DAY_MS);

  await SesionModel.create({
    id: randomUUID(),
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
 * when, and so an audit can see it happened at all.
 */
export async function revokeSession(id: string): Promise<void> {
  await SesionModel.update({ revoked_at: new Date() }, { where: { id, revoked_at: null } });
}

/** End every live session of one person. Returns how many were ended. */
export async function revokeAllSessionsOf(id_usuario: number): Promise<number> {
  const [count] = await SesionModel.update(
    { revoked_at: new Date() },
    { where: { id_usuario, revoked_at: null } },
  );
  return count;
}

/** The sessions a person could still be using, newest first. */
export async function listSessionsOf(id_usuario: number): Promise<ISesion[]> {
  const rows = await SesionModel.findAll({
    where: { id_usuario, revoked_at: null, expires_at: { [Op.gt]: new Date() } },
    order: [["last_used_at", "DESC"]],
  });
  return rows.map((r) => r.dataValues);
}

/**
 * Delete rows that cannot matter to anyone any more.
 *
 * Nothing else deletes from this table, so without this it only grows. The
 * cutoff is the absolute ceiling: past that, a row cannot authenticate anything
 * and is not recent enough to be interesting in a session list.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - SESSION_ABSOLUTE_DAYS * DAY_MS);
  return SesionModel.destroy({
    where: {
      [Op.or]: [{ expires_at: { [Op.lt]: cutoff } }, { revoked_at: { [Op.lt]: cutoff } }],
    },
  });
}
