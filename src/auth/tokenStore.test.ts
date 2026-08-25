// Redeeming and purging `token_uso_unico` rows.
//
// The model is mocked: what matters here is the shape of the query, not a
// real database enforcing it — this repo has no shared DB harness (see
// global-constraints.md, #11), so the `where` clause Sequelize is handed is
// the closest thing to a proof this suite can offer. Every condition below
// is asserted on the clause itself, with the exact operator, rather than on
// "the key is present" — a key present with the wrong operator (`Op.lt`
// where `Op.gt` belongs) would pass a shallower check and delete or accept
// exactly the wrong rows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const update = vi.fn();
const destroy = vi.fn();

vi.mock("../models/tokenUsoUnico.model.js", () => ({
  TokenUsoUnicoModel: {
    update: (...a: unknown[]) => update(...a),
    destroy: (...a: unknown[]) => destroy(...a),
  },
}));

const { consumirToken, purgeExpiredTokens } = await import("./tokenStore.js");
const { hashOpaqueToken } = await import("./opaqueToken.js");

/** The bound of a `{ [Op.x]: value }` clause, read past the Symbol key. */
const boundOf = (clause: unknown, op: symbol) => (clause as Record<symbol, unknown>)[op];
/** The operators actually present on a `{ [Op.x]: value }` clause. */
const opsOf = (clause: unknown) => Object.getOwnPropertySymbols(clause as object);

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue([0, []]);
  destroy.mockResolvedValue(0);
});

describe("consumirToken", () => {
  it("hashes the token before querying, and never sends the raw value", async () => {
    await consumirToken("un-token-crudo", "verify_email");
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(JSON.stringify(options.where)).not.toContain("un-token-crudo");
    expect(options.where.token_hash).toBe(hashOpaqueToken("un-token-crudo"));
  });

  it("returns the owner and the destination address when a row matched", async () => {
    update.mockResolvedValue([
      1,
      [{ dataValues: { id_usuario: 7, email_destino: "isaias@osefi.net" } }],
    ]);
    const result = await consumirToken("t", "reset_password");
    expect(result).toEqual({ id_usuario: 7, email_destino: "isaias@osefi.net" });
  });

  it("returns null when nothing matched — expired, used and unknown all answer the same", async () => {
    update.mockResolvedValue([0, []]);
    expect(await consumirToken("t", "reset_password")).toBeNull();
  });

  it("requires the token not to have been used already", async () => {
    // Demonstrated by breaking it: remove `used_at: null` from the WHERE in
    // tokenStore.ts and this assertion goes red, because the clause it reads
    // back no longer has the key — see task-2-report.md for the pasted
    // failure.
    update.mockResolvedValue([1, [{ dataValues: { id_usuario: 7, email_destino: "x@y.com" } }]]);
    await consumirToken("t", "verify_email");
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toHaveProperty("used_at", null);
  });

  it("requires the token not to have expired", async () => {
    // Demonstrated by breaking it: remove `expires_at: { [Op.gt]: ... }` and
    // this goes red — see task-2-report.md.
    update.mockResolvedValue([1, [{ dataValues: { id_usuario: 7, email_destino: "x@y.com" } }]]);
    const before = Date.now();
    await consumirToken("t", "verify_email");
    const after = Date.now();
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    const clause = options.where.expires_at;
    // An upper bound in the future (Op.gt "now"), not merely a mention of the
    // column — an inverted Op.lt would only ever redeem already-expired
    // tokens, and a key-presence check cannot tell the two apart.
    expect(opsOf(clause)).toContain(Op.gt);
    expect(opsOf(clause)).not.toContain(Op.lt);
    const bound = boundOf(clause, Op.gt) as Date;
    expect(bound.getTime()).toBeGreaterThanOrEqual(before);
    expect(bound.getTime()).toBeLessThanOrEqual(after);
  });

  it("requires the purpose to match — a verify_email token cannot redeem as reset_password", async () => {
    // Demonstrated by breaking it: remove `proposito` from the WHERE and this
    // goes red — see task-2-report.md.
    update.mockResolvedValue([1, [{ dataValues: { id_usuario: 7, email_destino: "x@y.com" } }]]);
    await consumirToken("t", "reset_password");
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toHaveProperty("proposito", "reset_password");
  });

  it("marks the row used with the moment of redemption, rather than deleting it", async () => {
    update.mockResolvedValue([1, [{ dataValues: { id_usuario: 7, email_destino: "x@y.com" } }]]);
    await consumirToken("t", "verify_email");
    const [values] = update.mock.calls[0] as [Record<string, unknown>];
    expect(values.used_at).toBeInstanceOf(Date);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("asks for the row it just matched, in the same statement", async () => {
    // Without `returning: true` the redemption and the read of who owns the
    // token would be two round trips instead of one atomic statement, which
    // is exactly the read-then-write race this function exists to avoid.
    await consumirToken("t", "verify_email");
    const [, options] = update.mock.calls[0] as [unknown, { returning?: boolean }];
    expect(options.returning).toBe(true);
  });
});

describe("purgeExpiredTokens", () => {
  it("deletes rows that were used or that expired", async () => {
    destroy.mockResolvedValue(5);
    expect(await purgeExpiredTokens()).toBe(5);

    const where = (destroy.mock.calls[0][0] as { where: Record<symbol, unknown> }).where;
    const clauses = where[Op.or] as Record<string, unknown>[];

    const usedBranch = clauses.find((c) => "used_at" in c);
    expect(usedBranch, "missing an Op.or branch for used_at").toBeDefined();
    // Op.ne against null renders as IS NOT NULL — a used row, not an unused
    // one. Op.eq (or the bare key) would invert this to "delete every row
    // that has never been used", which is every live token in the table.
    expect(opsOf(usedBranch!.used_at)).toContain(Op.ne);

    const expiredBranch = clauses.find((c) => "expires_at" in c);
    expect(expiredBranch, "missing an Op.or branch for expires_at").toBeDefined();
    expect(opsOf(expiredBranch!.expires_at)).toContain(Op.lt);
    expect(opsOf(expiredBranch!.expires_at)).not.toContain(Op.gt);
    const cutoff = boundOf(expiredBranch!.expires_at, Op.lt) as Date;
    expect(Math.abs(cutoff.getTime() - Date.now())).toBeLessThan(1000);
  });
});
