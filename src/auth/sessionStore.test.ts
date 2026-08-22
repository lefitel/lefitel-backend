// Creating, finding and ending sessions.
//
// The model is mocked: what matters here is the shape of what gets written and
// the conditions of what gets read. A session that stays valid after being
// revoked, or one whose lookup forgets to check expiry, is the whole reason
// this table exists — so those are the assertions, not the happy path.
//
// Several checks below read a Sequelize operator clause (`{ [Op.gt]: ... }`)
// directly instead of `JSON.stringify`-ing the `where` and matching a regex
// against it. `JSON.stringify` drops Symbol-keyed properties entirely, so a
// stringified clause can prove a *key* like `expires_at` is present but can
// never prove which operator or bound it holds — an `Op.gt` flipped to
// `Op.lt` (a query that returns only dead rows) stringifies to the exact
// same text as the correct one.

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
  revokeSessionOf,
  revokeAllSessionsOf,
  listSessionsOf,
  purgeExpiredSessions,
  slidingExpiry,
} = await import("./sessionStore.js");
const { hashSessionToken } = await import("./sessionToken.js");
const {
  SESSION_IDLE_DAYS,
  SESSION_ABSOLUTE_DAYS,
  SESSION_USER_AGENT_MAX,
  SESSION_IP_MAX,
} = await import("../config/security.js");

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
/** The bound of a `{ [Op.x]: value }` clause, read past the Symbol key. */
const boundOf = (clause: unknown, op: symbol) => (clause as Record<symbol, unknown>)[op];
/** The operators actually present on a `{ [Op.x]: value }` clause. */
const opsOf = (clause: unknown) => Object.getOwnPropertySymbols(clause as object);

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

  it("writes a complete, well-formed row", async () => {
    // Cheap insurance: dropping id_usuario, created_at, last_used_at or the
    // revoked_at: null would pass every other test here and fail in
    // production against a NOT NULL column instead.
    await createSession(7, {});
    const row = written();
    expect(row.id_usuario).toBe(7);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.last_used_at).toBeInstanceOf(Date);
    expect(row.expires_at).toBeInstanceOf(Date);
    expect(row.revoked_at).toBeNull();
  });

  it("truncates a browser's absurd user agent instead of failing the insert", async () => {
    const enviado = "x".repeat(400);
    await createSession(7, { userAgent: enviado });
    // Not just "short enough": the stored value has to be the input's own
    // prefix, or a function that always returned e.g. an empty string would
    // pass a bare length check too.
    expect(written().user_agent).toBe(enviado.slice(0, SESSION_USER_AGENT_MAX));
    expect(String(written().user_agent).length).toBe(SESSION_USER_AGENT_MAX);
  });

  it("truncates an oversized IP instead of failing the insert", async () => {
    // `ip_address` is STRING(SESSION_IP_MAX), the length of one IPv6 address.
    // Postgres does not truncate to fit a column: an oversized value fails
    // the insert outright (error 22001), which would turn a login into a 500
    // instead of a session.
    const enviado = "1".repeat(400);
    await createSession(7, { ip: enviado });
    expect(written().ip_address).toBe(enviado.slice(0, SESSION_IP_MAX));
    expect(String(written().ip_address).length).toBe(SESSION_IP_MAX);
  });

  it("keeps only the first hop of a comma-separated forwarded-for chain", async () => {
    // The realistic shape of an oversized ip, if `trust proxy` were ever
    // misconfigured: several addresses, not one long one. The client's own
    // address is the first, and is what a session list should show.
    await createSession(7, { ip: "203.0.113.5, 10.0.0.1, 10.0.0.2" });
    expect(written().ip_address).toBe("203.0.113.5");
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
    const before = Date.now();
    await findLiveSession("t");
    const after = Date.now();
    const clause = lookedUpWith().expires_at;
    // The clause has to be an upper bound in the future (Op.gt "now"), not
    // merely mention expires_at — an inverted Op.lt would return only
    // sessions that already expired, and a stringify-based check cannot
    // tell the two apart.
    expect(opsOf(clause)).toContain(Op.gt);
    expect(opsOf(clause)).not.toContain(Op.lt);
    const bound = boundOf(clause, Op.gt) as Date;
    expect(bound.getTime()).toBeGreaterThanOrEqual(before);
    expect(bound.getTime()).toBeLessThanOrEqual(after);
  });

  it("requires the session not to have passed the thirty-day absolute ceiling", async () => {
    // A session used every day forever must still die at some point — this
    // is the condition the idle expiry alone cannot provide, and the one most
    // likely to be the one a later edit drops.
    findOne.mockResolvedValue(null);
    await findLiveSession("t");
    const where = lookedUpWith();
    expect(where).toHaveProperty("created_at");
    const clause = where.created_at;
    expect(opsOf(clause)).toContain(Op.gt);
    const cutoff = boundOf(clause, Op.gt) as Date;
    const dias = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(SESSION_ABSOLUTE_DAYS - 0.01);
    expect(dias).toBeLessThan(SESSION_ABSOLUTE_DAYS + 0.01);
  });

  it("returns null when there is no row, rather than something falsy-ish", async () => {
    findOne.mockResolvedValue(null);
    expect(await findLiveSession("t")).toBeNull();
  });

  it("selects and returns created_at, which the cookie's own absolute cap needs", async () => {
    // `authenticate` reissues the cookie on every touch, and the reissued
    // `Expires` may never pass this session's own thirtieth day — a bound it
    // cannot enforce without `created_at`. Sequelize only returns the columns
    // named in `attributes`, so this is two failures in one: the column
    // missing from the SELECT, or dropped again on the way out of the
    // function, both leave the caller with `undefined`.
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    findOne.mockResolvedValue({
      dataValues: {
        id: "s1",
        id_usuario: 7,
        created_at: createdAt,
        expires_at: new Date(),
        last_used_at: new Date(),
      },
    });
    const found = await findLiveSession("t");
    expect(found?.created_at).toEqual(createdAt);
    const [options] = findOne.mock.calls[0] as [{ attributes: string[] }];
    expect(options.attributes).toContain("created_at");
  });
});

describe("slidingExpiry", () => {
  it("slides forward from `at` when that stays under the absolute ceiling", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const at = new Date("2026-01-03T00:00:00.000Z"); // two days into the session
    const dias = (slidingExpiry(createdAt, at).getTime() - at.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(SESSION_IDLE_DAYS - 0.01);
    expect(dias).toBeLessThan(SESSION_IDLE_DAYS + 0.01);
  });

  it("caps at the absolute ceiling instead of sliding past it", () => {
    // A session touched daily for its whole life: by day 25, sliding seven
    // more days would land on day 32 — past the thirty-day ceiling this
    // session was created under. The cookie must not promise day 32.
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const at = new Date(createdAt.getTime() + 25 * 86_400_000);
    const ceiling = new Date(createdAt.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000);
    expect(slidingExpiry(createdAt, at)).toEqual(ceiling);
  });

  it("returns exactly the ceiling, not a day short of it, right at the boundary", () => {
    // Guards against an off-by-one (`<=` written as `<`, or a stray
    // `- DAY_MS`) that would shave a day off a session that is still,
    // correctly, allowed to reach the full thirty.
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const at = new Date(createdAt.getTime() + (SESSION_ABSOLUTE_DAYS - 1) * 86_400_000);
    const ceiling = new Date(createdAt.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000);
    expect(slidingExpiry(createdAt, at)).toEqual(ceiling);
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
  it("revokes every live session of one person and says how many", async () => {
    update.mockResolvedValue([3]);
    expect(await revokeAllSessionsOf(7)).toBe(3);
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toMatchObject({ id_usuario: 7, revoked_at: null });
  });

  it("marks one session revoked instead of deleting the row", async () => {
    // Kept, so the profile screen can show that it was ended and when. And the
    // `revoked_at: null` guard: without it, revoking an already-revoked session
    // would overwrite its original revocation time with a later one.
    update.mockResolvedValue([1]);
    await revokeSessionOf(7, "una-id");
    const [values] = update.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(values.revoked_at).toBeInstanceOf(Date);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("will not revoke one session without being told whose it is", async () => {
    // The IDOR surface of this plan, asserted where it is actually decided.
    // `DELETE /api/auth/sessions/:id` takes the id from the URL, so `id` alone
    // in this `where` means any account with a session can close anybody
    // else's. This repository has already shipped a `:id` route that trusted
    // the URL, and it let any authenticated user make themselves an
    // administrator.
    update.mockResolvedValue([1]);
    expect(await revokeSessionOf(7, "una-id")).toBe(true);
    const [values, options] = update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(values.revoked_at).toBeInstanceOf(Date);
    // The exact where and not a subset: the whole point is that `id_usuario` is
    // in there, and `toMatchObject({ id })` would pass with it missing.
    expect(options.where).toEqual({ id: "una-id", id_usuario: 7, revoked_at: null });
  });

  it("says no when the update matched nothing, so the route can answer 404", async () => {
    // Not yours, never existed, already closed — one answer for all three, so
    // the endpoint cannot be used to find out which. A 403 would confirm the
    // row exists and belongs to somebody.
    update.mockResolvedValue([0]);
    expect(await revokeSessionOf(7, "una-id")).toBe(false);
  });

  it("spares one session when asked, and only that one", async () => {
    // What a password change needs: everything of that person's ends except the
    // browser they changed it from, which otherwise gets a 200 followed
    // immediately by a 401 and reads as the change having failed.
    update.mockResolvedValue([2]);
    await revokeAllSessionsOf(7, { except: "la-actual" });
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toMatchObject({ id_usuario: 7, revoked_at: null });
    expect(boundOf(options.where.id, Op.ne)).toBe("la-actual");
  });

  it("revokes everything when the session to spare is undefined", async () => {
    // The branch that matters most, and the one that fails silently if it is
    // written as `if ("except" in options)`. A request that arrived on the old
    // bearer token has no session row, so callers pass `undefined` straight
    // through; written that way the clause becomes `id != NULL`, which is never
    // true in SQL, so the update would match **nothing** and a password change
    // would revoke no sessions at all — while answering 200.
    update.mockResolvedValue([4]);
    for (const options of [{}, { except: undefined }, { except: "" }]) {
      update.mockClear();
      expect(await revokeAllSessionsOf(7, options)).toBe(4);
      const [, opts] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
      expect(opts.where, JSON.stringify(options)).toEqual({ id_usuario: 7, revoked_at: null });
      expect(opts.where.id, JSON.stringify(options)).toBeUndefined();
    }
  });

  it("runs inside the caller's transaction when it is given one", async () => {
    // `deleteUsuario` archives an account and ends its sessions, and half of
    // that is worse than none: archived with live sessions is the hole itself.
    // Without the option reaching the query, the revocation would commit on its
    // own and a rolled-back archive would leave somebody locked out of an
    // account that still looks fine.
    const transaction = { id: "una-transaccion" } as unknown as Parameters<
      typeof revokeAllSessionsOf
    >[1]["transaction"];
    update.mockResolvedValue([1]);
    await revokeAllSessionsOf(7, { transaction });
    const [, options] = update.mock.calls[0] as [unknown, { transaction?: unknown }];
    expect(options.transaction).toBe(transaction);
  });
});

describe("listSessionsOf", () => {
  it("only lists sessions that are still live, newest use first", async () => {
    findAll.mockResolvedValue([]);
    await listSessionsOf(7);
    const [options] = findAll.mock.calls[0] as [{ where: Record<string, unknown>; order: unknown }];
    expect(options.where).toMatchObject({ id_usuario: 7, revoked_at: null });
    const clause = options.where.expires_at;
    expect(opsOf(clause)).toContain(Op.gt);
    expect(opsOf(clause)).not.toContain(Op.lt);
    expect(options.order).toEqual([["last_used_at", "DESC"]]);
  });

  it("never hands the token hash to whatever renders this list", async () => {
    // This list is what the profile screen turns into a res.json. Nothing
    // can be done with a SHA-256 of a 256-bit token, but the module's whole
    // premise is that the hash does not leave the database — this is the one
    // read path where "harmless if leaked" is not the same as "fine to skip".
    findAll.mockResolvedValue([]);
    await listSessionsOf(7);
    const [options] = findAll.mock.calls[0] as [{ attributes: { exclude: string[] } }];
    expect(options.attributes).toEqual({ exclude: ["token_hash"] });
  });

  it("hands back plain rows, not the model wrapper", async () => {
    findAll.mockResolvedValue([{ dataValues: { id: "a" } }, { dataValues: { id: "b" } }]);
    expect(await listSessionsOf(7)).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("purgeExpiredSessions", () => {
  it("deletes rows whose idle expiry, revocation, or absolute ceiling is more than thirty days behind", async () => {
    destroy.mockResolvedValue(12);
    expect(await purgeExpiredSessions()).toBe(12);
    const where = (destroy.mock.calls[0][0] as { where: Record<symbol, unknown> }).where;
    const clauses = where[Op.or] as Record<string, unknown>[];

    // Each of the three columns must appear in its own Op.or branch, each
    // bounded with Op.lt (strictly in the past) rather than Op.gt — the
    // inverted operator is what would delete every *live* row instead of the
    // dead ones, and a mere "the key is present" check cannot catch that.
    for (const column of ["expires_at", "revoked_at", "created_at"]) {
      const branch = clauses.find((c) => column in c);
      expect(branch, `missing an Op.or branch for ${column}`).toBeDefined();
      const clause = branch![column];
      expect(opsOf(clause)).toContain(Op.lt);
      expect(opsOf(clause)).not.toContain(Op.gt);
      const cutoff = boundOf(clause, Op.lt) as Date;
      const dias = (Date.now() - cutoff.getTime()) / 86_400_000;
      expect(dias).toBeGreaterThan(SESSION_ABSOLUTE_DAYS - 0.01);
      expect(dias).toBeLessThan(SESSION_ABSOLUTE_DAYS + 0.01);
    }
  });
});
