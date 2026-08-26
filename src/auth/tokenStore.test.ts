// Minting, redeeming and purging `token_uso_unico` rows.
//
// Most of this file mocks the model and asserts the shape of the query, not
// a real database enforcing it — this repo has no shared DB harness (see
// global-constraints.md, #11), so the `where` clause Sequelize is handed is
// the closest thing to a proof this suite can offer for those. Every
// condition is asserted on the clause itself, with the exact operator,
// rather than on "the key is present" — a key present with the wrong
// operator (`Op.lt` where `Op.gt` belongs) would pass a shallower check and
// delete or accept exactly the wrong rows.
//
// The one exception is the "crearToken and consumirToken together" block at
// the bottom, which needs to show a *behaviour* — that minting a second
// token really does leave the first one dead — and a shape assertion on a
// `where` clause cannot show that. It runs `create` and `update` against a
// tiny in-memory array instead of a canned return value, just for that block.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const create = vi.fn();
const update = vi.fn();
const destroy = vi.fn();

vi.mock("../models/tokenUsoUnico.model.js", () => ({
  TokenUsoUnicoModel: {
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    destroy: (...a: unknown[]) => destroy(...a),
  },
}));

// `crearToken` wraps its two writes in `sequelize.transaction(...)` — see the
// same pattern and the same mock shape in `usuario.controller.test.ts`. The
// fake just invokes the callback with a fixed token standing in for the real
// transaction object, so every write inside can be asserted to carry it.
const TRANSACCION = { id: "una-transaccion" };
const transaction = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...a: unknown[]) => transaction(...a) },
}));

const { crearToken, consumirToken, purgeExpiredTokens } = await import("./tokenStore.js");
const { hashOpaqueToken } = await import("./opaqueToken.js");
const { EMAIL_VERIFY_TOKEN_TTL_MS, PASSWORD_RESET_TOKEN_TTL_MS } = await import("../config/security.js");
const { sequelize } = await import("../database/sequelize.js");

/** The bound of a `{ [Op.x]: value }` clause, read past the Symbol key. */
const boundOf = (clause: unknown, op: symbol) => (clause as Record<symbol, unknown>)[op];
/** The operators actually present on a `{ [Op.x]: value }` clause. */
const opsOf = (clause: unknown) => Object.getOwnPropertySymbols(clause as object);
/**
 * `where`-clause matching against a plain object — just enough for the two
 * shapes this module produces (equality, including against `null`, and
 * `{ [Op.gt]: Date }`). Shared by the two in-memory fake tables below.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, clause]) => {
    if (clause !== null && typeof clause === "object" && !(clause instanceof Date)) {
      const gt = (clause as Record<symbol, unknown>)[Op.gt];
      if (gt instanceof Date) return (row[key] as Date).getTime() > gt.getTime();
    }
    return row[key] === clause;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ dataValues: {} });
  update.mockResolvedValue([0, []]);
  destroy.mockResolvedValue(0);
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
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

describe("crearToken", () => {
  it("returns a fresh opaque token and stores only its hash", async () => {
    const token = await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "verify_email",
    });
    const [values] = create.mock.calls[0] as [Record<string, unknown>];
    expect(values.token_hash).toBe(hashOpaqueToken(token));
    expect(values.token_hash).not.toBe(token);
  });

  it("never writes the plain token anywhere it could be read back", async () => {
    const token = await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "verify_email",
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain(token);
    // The invalidation call never sees a token at all — checked anyway,
    // because a future edit that threaded it through for no reason should
    // not go unnoticed.
    expect(JSON.stringify(update.mock.calls)).not.toContain(token);
  });

  it("gives verify_email one hour, not a duration the caller chose", async () => {
    const before = Date.now();
    await crearToken({ id_usuario: 7, email_destino: "isaias@osefi.net", proposito: "verify_email" });
    const after = Date.now();
    const [values] = create.mock.calls[0] as [Record<string, unknown>];
    const restante = (values.expires_at as Date).getTime() - after;
    // `before`/`after` bracket the call; `expires_at` was computed from a
    // `Date.now()` somewhere inside that bracket, so `restante` (measured
    // from the *later* of the two bounds) is at most the full TTL, and at
    // least the TTL minus however long the call itself took.
    expect(restante).toBeGreaterThan(EMAIL_VERIFY_TOKEN_TTL_MS - (after - before) - 1000);
    expect(restante).toBeLessThanOrEqual(EMAIL_VERIFY_TOKEN_TTL_MS);
  });

  it("gives reset_password fifteen minutes — the purpose decides, the caller does not", async () => {
    // There is no argument on `crearToken` for a duration at all: the input
    // type has no such field, so a caller cannot ask for one even by
    // accident. What this pins is that the *purpose* alone selects a
    // different, shorter number.
    const before = Date.now();
    await crearToken({ id_usuario: 7, email_destino: "isaias@osefi.net", proposito: "reset_password" });
    const after = Date.now();
    const [values] = create.mock.calls[0] as [Record<string, unknown>];
    const restante = (values.expires_at as Date).getTime() - after;
    expect(restante).toBeGreaterThan(PASSWORD_RESET_TOKEN_TTL_MS - (after - before) - 1000);
    expect(restante).toBeLessThanOrEqual(PASSWORD_RESET_TOKEN_TTL_MS);
    expect(PASSWORD_RESET_TOKEN_TTL_MS).toBeLessThan(EMAIL_VERIFY_TOKEN_TTL_MS);
  });

  it("invalidates only the still-pending tokens of the same account and purpose", async () => {
    await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "reset_password",
    });
    const [values, options] = update.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(values.used_at).toBeInstanceOf(Date);
    // The exact where, not a subset: leaving out `used_at: null` here would
    // re-stamp rows already redeemed, overwriting the true moment they were
    // used with the moment a later, unrelated token was minted.
    expect(options.where).toEqual({ id_usuario: 7, proposito: "reset_password", used_at: null });
  });

  it("runs the invalidation and the insert inside the same transaction", async () => {
    await crearToken({ id_usuario: 7, email_destino: "isaias@osefi.net", proposito: "verify_email" });
    const [, updateOptions] = update.mock.calls[0] as [unknown, { transaction: unknown }];
    const [, createOptions] = create.mock.calls[0] as [unknown, { transaction: unknown }];
    expect(updateOptions.transaction).toBe(TRANSACCION);
    expect(createOptions.transaction).toBe(TRANSACCION);
  });
});

describe("crearToken and consumirToken together", () => {
  /**
   * A tiny in-memory stand-in for the table, used only in this block.
   *
   * Every test above treats `create`/`update` as opaque calls and checks
   * their arguments — correct for pinning a query's shape, but unable to
   * show that minting a second token actually leaves the first dead: that
   * claim is about what happens when both functions run against the *same*
   * data, which a canned return value cannot represent. This makes `create`
   * and `update` operate on a real (if tiny) array instead, so the two
   * functions genuinely interact the way they would through a real table.
   */
  function fakeTable() {
    const rows: Record<string, unknown>[] = [];
    create.mockImplementation(async (values: Record<string, unknown>) => {
      const row = { ...values };
      rows.push(row);
      return { dataValues: row };
    });
    update.mockImplementation(
      async (values: Record<string, unknown>, options: { where: Record<string, unknown> }) => {
        const matched = rows.filter((row) => matches(row, options.where));
        matched.forEach((row) => Object.assign(row, values));
        return [matched.length, matched.map((row) => ({ dataValues: row }))];
      },
    );
    return rows;
  }

  it("leaves the previous token dead once a second one is minted for the same account and purpose", async () => {
    fakeTable();
    const primero = await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "reset_password",
    });
    const segundo = await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "reset_password",
    });

    expect(await consumirToken(primero, "reset_password")).toBeNull();
    expect(await consumirToken(segundo, "reset_password")).toEqual({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
    });
  });

  it("leaves a pending token of a different purpose for the same account alone", async () => {
    fakeTable();
    const verificacion = await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "verify_email",
    });
    await crearToken({ id_usuario: 7, email_destino: "isaias@osefi.net", proposito: "reset_password" });

    expect(await consumirToken(verificacion, "verify_email")).toEqual({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
    });
  });

  it("leaves a pending token of the same purpose for a different account alone", async () => {
    fakeTable();
    const deOtraCuenta = await crearToken({
      id_usuario: 9,
      email_destino: "otro@osefi.net",
      proposito: "reset_password",
    });
    await crearToken({ id_usuario: 7, email_destino: "isaias@osefi.net", proposito: "reset_password" });

    expect(await consumirToken(deOtraCuenta, "reset_password")).toEqual({
      id_usuario: 9,
      email_destino: "otro@osefi.net",
    });
  });

  it("never stores the plain token anywhere in the table", async () => {
    const rows = fakeTable();
    const token = await crearToken({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      proposito: "verify_email",
    });

    expect(rows.every((row) => row.token_hash !== token)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe("consumirToken with a caller-provided transaction", () => {
  it("behaves exactly as before when no transaction is given", async () => {
    // Every test in the plain `consumirToken` describe above already calls
    // it with two arguments and passes; this pins the omission on the wire
    // itself, so a change that silently starts requiring the third
    // argument — or defaults it to something other than "no transaction" —
    // is caught here rather than only in a type error at some future call
    // site.
    await consumirToken("t", "verify_email");
    const [, options] = update.mock.calls[0] as [unknown, { transaction?: unknown }];
    expect(options.transaction).toBeUndefined();
  });

  /**
   * The scope that stops a token being redeemed by the wrong account.
   *
   * The attack it closes, from the final review: B puts A's address on B's own
   * account — which the partial unique index allows on purpose, because an
   * unverified claim must not block the real owner of a mailbox. The
   * verification mail then goes to A's inbox, since that is the address on it.
   * A clicks the link while logged in as A, and the handler verified **B's**
   * account, because the token's row said so. A saw "Correo verificado" and
   * had verified nothing, while A's own address became permanently
   * unclaimable: only one account may ever verify it, and `email` is not an
   * administrator-editable field. Silent, permanent, and performed by the
   * victim.
   */
  it("scopes the UPDATE to one account when asked, so a planted token cannot be redeemed by its target", async () => {
    update.mockResolvedValue([0, []]);
    await consumirToken("t", "verify_email", { soloDelUsuario: 7 });

    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toMatchObject({ id_usuario: 7 });
  });

  it("leaves the scope out entirely when nobody asked, rather than guessing an account", async () => {
    update.mockResolvedValue([0, []]);
    await consumirToken("t", "reset_password");

    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    // `/password/reset` is public: there is no session to scope it to, and the
    // token's own row is the only thing that says whose account it is. A
    // `id_usuario: undefined` slipped into the `where` would be far worse than
    // its absence — Sequelize renders that as `IS NULL`, and the column is NOT
    // NULL, so every redemption would silently match nothing.
    expect(options.where).not.toHaveProperty("id_usuario");
  });

  it("passes a given transaction straight through to the same UPDATE", async () => {
    const DEL_LLAMADOR = { id: "la-transaccion-de-quien-llama" };
    await consumirToken(
      "t",
      "verify_email",
      { transaction: DEL_LLAMADOR as unknown as never },
    );
    const [, options] = update.mock.calls[0] as [unknown, { transaction?: unknown }];
    expect(options.transaction).toBe(DEL_LLAMADOR);
  });

  /**
   * A rollback-aware fake table, for the one test below that needs it.
   *
   * A real Postgres transaction is invisible to anything outside it until
   * it commits, and every write inside it vanishes on ROLLBACK. `fakeTable`
   * above cannot show that: its `update` mutates one shared array with no
   * notion of "inside" or "outside" a transaction, so it cannot tell a
   * write that respected the transaction apart from one that bypassed it.
   *
   * This keeps two views: `committed`, the table as anyone outside the
   * transaction sees it, and `pending`, a working copy only writes tagged
   * with the currently-open transaction's own token touch. On success,
   * `pending` becomes the new `committed` — the commit. On the callback
   * throwing, `pending` is simply discarded — the rollback — and
   * `committed` is left exactly as any write that did *not* carry the
   * transaction already left it. That last part is what makes the
   * demonstration below possible: a write missing the `transaction` option
   * lands on `committed` immediately and is never rolled back, which is
   * exactly what a real, un-transacted query does against a real database
   * too.
   */
  function fakeTransactionalTable() {
    const committed: Record<string, unknown>[] = [];
    let pending: Record<string, unknown>[] | null = null;
    let openToken: unknown = null;

    update.mockImplementation(
      async (
        values: Record<string, unknown>,
        options: { where: Record<string, unknown>; transaction?: unknown },
      ) => {
        const inTransaction = pending !== null && options.transaction === openToken;
        const target = inTransaction ? pending! : committed;
        const matched = target.filter((row) => matches(row, options.where));
        matched.forEach((row) => Object.assign(row, values));
        return [matched.length, matched.map((row) => ({ dataValues: row }))];
      },
    );

    transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => {
      openToken = TRANSACCION;
      pending = committed.map((row) => ({ ...row }));
      try {
        const result = await fn(openToken);
        // COMMIT: the transaction's own view of the world becomes the truth.
        committed.length = 0;
        committed.push(...pending);
        return result;
      } finally {
        // On a throw, execution never reaches the two lines above, so
        // `committed` is left untouched by anything that respected the
        // transaction — which *is* the rollback. Nothing to undo here.
        pending = null;
        openToken = null;
      }
    });

    return committed;
  }

  it("leaves the token still redeemable when the caller's own transaction rolls back", async () => {
    // Demonstrated by breaking it: remove `transaction` from the options
    // `consumirToken` hands to `TokenUsoUnicoModel.update` and this goes
    // red, because the redemption below then bypasses the fake transaction
    // entirely and commits immediately — see task-2-report.md for the
    // pasted failure.
    const rows = fakeTransactionalTable();
    rows.push({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
      token_hash: hashOpaqueToken("un-token"),
      proposito: "reset_password",
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
    });

    await expect(
      sequelize.transaction(async (t: unknown) => {
        const result = await consumirToken(
          "un-token",
          "reset_password",
          { transaction: t as unknown as never },
        );
        expect(result).not.toBeNull();
        // The case this parameter exists for: something after the
        // redemption fails — hashing or writing the new password, clearing
        // the lockout, revoking sessions — before `/password/reset` finishes.
        throw new Error("simulated failure after redemption, before the reset finished");
      }),
    ).rejects.toThrow("simulated failure after redemption");

    // Outside that rolled-back transaction, the token is exactly as it was
    // before: still pending, still redeemable.
    expect(await consumirToken("un-token", "reset_password")).toEqual({
      id_usuario: 7,
      email_destino: "isaias@osefi.net",
    });
  });
});
