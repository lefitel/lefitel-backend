// Creating, finding and ending sessions.
//
// The model is mocked: what matters here is the shape of what gets written and
// the conditions of what gets read. A session that stays valid after being
// revoked, or one whose lookup forgets to check expiry, is the whole reason
// this table exists — so those are the assertions, not the happy path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const create = vi.fn();
const findOne = vi.fn();
const findAll = vi.fn();
const update = vi.fn();
const destroy = vi.fn();

vi.mock("../models/sesion.model.js", () => ({
  SesionModel: {
    create: (...a: unknown[]) => create(...a),
    findOne: (...a: unknown[]) => findOne(...a),
    findAll: (...a: unknown[]) => findAll(...a),
    update: (...a: unknown[]) => update(...a),
    destroy: (...a: unknown[]) => destroy(...a),
  },
}));

const {
  createSession,
  findLiveSession,
  touchSession,
  revokeSession,
  revokeAllSessionsOf,
  listSessionsOf,
  purgeExpiredSessions,
} = await import("./sessionStore.js");
const { hashSessionToken } = await import("./sessionToken.js");
const { SESSION_IDLE_DAYS, SESSION_ABSOLUTE_DAYS } = await import("../config/security.js");

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ dataValues: {} });
  update.mockResolvedValue([1]);
  destroy.mockResolvedValue(0);
});

/** The row the store handed to the model. */
const written = () => create.mock.calls[0][0] as Record<string, unknown>;
/** The `where` the store used to look a session up. */
const lookedUpWith = () => (findOne.mock.calls[0][0] as { where: Record<string, unknown> }).where;

describe("createSession", () => {
  it("never writes the token itself", async () => {
    // The one property that makes this table safe to dump.
    const { token } = await createSession(7, {});
    expect(JSON.stringify(written())).not.toContain(token);
    expect(written().token_hash).toBe(hashSessionToken(token));
  });

  it("returns a token that is not what it stored", async () => {
    const { token } = await createSession(7, {});
    expect(token).not.toBe(written().token_hash);
  });

  it("expires at the idle limit, not at the absolute one", async () => {
    const { expiresAt } = await createSession(7, {});
    const dias = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(SESSION_IDLE_DAYS - 0.01);
    expect(dias).toBeLessThan(SESSION_IDLE_DAYS + 0.01);
  });

  it("truncates a browser's absurd user agent instead of failing the insert", async () => {
    await createSession(7, { userAgent: "x".repeat(400) });
    expect(String(written().user_agent).length).toBeLessThanOrEqual(255);
  });

  it("truncates an oversized IP instead of failing the insert", async () => {
    // `ip_address` is STRING(45), the length of one IPv6 address. Behind the
    // `trust proxy` this server runs with, `X-Forwarded-For` arrives as a
    // comma-separated chain of every hop once there is more than one, which
    // runs past that easily. Postgres does not truncate to fit a column: an
    // oversized value fails the insert outright (error 22001), which would
    // turn a login into a 500 instead of a session.
    await createSession(7, { ip: "1".repeat(400) });
    expect(String(written().ip_address).length).toBeLessThanOrEqual(45);
  });
});

describe("findLiveSession", () => {
  it("looks up by the hash, never by the token", async () => {
    findOne.mockResolvedValue(null);
    await findLiveSession("un-token");
    expect(JSON.stringify(lookedUpWith())).not.toContain("un-token");
    expect(lookedUpWith().token_hash).toBe(hashSessionToken("un-token"));
  });

  it("requires the session not to be revoked", async () => {
    findOne.mockResolvedValue(null);
    await findLiveSession("t");
    expect(lookedUpWith()).toHaveProperty("revoked_at", null);
  });

  it("requires the session not to have expired", async () => {
    findOne.mockResolvedValue(null);
    await findLiveSession("t");
    expect(JSON.stringify(lookedUpWith())).toMatch(/expires_at/);
  });

  it("requires the session not to have passed the thirty-day absolute ceiling", async () => {
    // A session used every day forever must still die at some point — this
    // is the condition the idle expiry alone cannot provide, and the one most
    // likely to be the one a later edit drops.
    findOne.mockResolvedValue(null);
    await findLiveSession("t");
    const where = lookedUpWith();
    expect(where).toHaveProperty("created_at");
    const clause = where.created_at as Record<symbol, Date>;
    const cutoff = clause[Op.gt];
    const dias = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(SESSION_ABSOLUTE_DAYS - 0.01);
    expect(dias).toBeLessThan(SESSION_ABSOLUTE_DAYS + 0.01);
  });

  it("returns null when there is no row, rather than something falsy-ish", async () => {
    findOne.mockResolvedValue(null);
    expect(await findLiveSession("t")).toBeNull();
  });
});

describe("touchSession", () => {
  it("pushes the idle expiry forward from the moment it was used", async () => {
    const at = new Date();
    await touchSession("una-id", at);
    const [values, options] = update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(values.last_used_at).toBe(at);
    expect(options.where).toMatchObject({ id: "una-id" });
    const dias = ((values.expires_at as Date).getTime() - at.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(SESSION_IDLE_DAYS - 0.01);
    expect(dias).toBeLessThan(SESSION_IDLE_DAYS + 0.01);
  });
});

describe("revoking", () => {
  it("marks one session revoked instead of deleting the row", async () => {
    // Kept, so the profile screen can show that it was ended and when.
    await revokeSession("una-id");
    expect(update).toHaveBeenCalled();
    const [values, options] = update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(values.revoked_at).toBeInstanceOf(Date);
    expect(options.where).toMatchObject({ id: "una-id" });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("revokes every live session of one person and says how many", async () => {
    update.mockResolvedValue([3]);
    expect(await revokeAllSessionsOf(7)).toBe(3);
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toMatchObject({ id_usuario: 7, revoked_at: null });
  });
});

describe("listSessionsOf", () => {
  it("only lists sessions that are still live, newest use first", async () => {
    findAll.mockResolvedValue([]);
    await listSessionsOf(7);
    const [options] = findAll.mock.calls[0] as [{ where: Record<string, unknown>; order: unknown }];
    expect(options.where).toMatchObject({ id_usuario: 7, revoked_at: null });
    expect(JSON.stringify(options.where)).toMatch(/expires_at/);
    expect(options.order).toEqual([["last_used_at", "DESC"]]);
  });

  it("hands back plain rows, not the model wrapper", async () => {
    findAll.mockResolvedValue([{ dataValues: { id: "a" } }, { dataValues: { id: "b" } }]);
    expect(await listSessionsOf(7)).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("purgeExpiredSessions", () => {
  it("deletes rows that are long past being useful, and only those", async () => {
    // Note: `where` here is `{ [Op.or]: [...] }` — a single Symbol-keyed
    // property. `JSON.stringify` drops Symbol keys entirely, so stringifying
    // this `where` (unlike `findLiveSession`'s, whose Symbol keys sit one
    // level deeper under plain string keys) always yields "{}" and can never
    // match anything — the check has to look at the clauses directly.
    destroy.mockResolvedValue(12);
    expect(await purgeExpiredSessions()).toBe(12);
    const where = (destroy.mock.calls[0][0] as { where: Record<symbol, unknown> }).where;
    const clauses = where[Op.or] as Record<string, unknown>[];
    expect(clauses.some((c) => "expires_at" in c)).toBe(true);
    expect(clauses.some((c) => "revoked_at" in c)).toBe(true);
    // The absolute ceiling is the longest a row can matter for.
    expect(SESSION_ABSOLUTE_DAYS).toBeGreaterThan(0);
  });
});
