// Writing down a WebAuthn challenge, spending it, and sweeping the dead ones.
//
// Same approach as `tokenStore.test.ts`, and the same reason: this repo has no
// shared database harness (global-constraints.md #11), so the `where` clause
// Sequelize is handed is the closest thing to a proof available here. Every
// condition is asserted with its **exact operator**, never as "the key is
// present" — `Op.lt` where `Op.gt` belongs would pass a shallower check while
// accepting precisely the expired challenges this table exists to refuse.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const create = vi.fn();
const update = vi.fn();
const destroy = vi.fn();
const findOne = vi.fn();
const findAll = vi.fn();

vi.mock("../models/retoWebauthn.model.js", () => ({
  RetoWebauthnModel: {
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    destroy: (...a: unknown[]) => destroy(...a),
    // Present on the fake purely so the tests below can assert they are
    // **never** called — see "one statement" further down.
    findOne: (...a: unknown[]) => findOne(...a),
    findAll: (...a: unknown[]) => findAll(...a),
  },
}));

const { guardarReto, consumirReto, purgarRetosCaducados } = await import("./retoStore.js");
const { hashOpaqueToken } = await import("./opaqueToken.js");
const { WEBAUTHN_CHALLENGE_TTL_MS } = await import("../config/security.js");

const RETO = "un-reto-que-la-libreria-acaba-de-generar";
const HASH = hashOpaqueToken(RETO);

beforeEach(() => {
  create.mockReset().mockResolvedValue({});
  update.mockReset().mockResolvedValue([0, []]);
  destroy.mockReset().mockResolvedValue(0);
  findOne.mockReset();
  findAll.mockReset();
});

describe("guardarReto", () => {
  it("writes down the hash and never the challenge", async () => {
    await guardarReto(RETO, "registro", { id_usuario: 7, id_sesion: "s-1" });

    const fila = create.mock.calls[0][0] as Record<string, unknown>;
    expect(fila.reto_hash).toBe(HASH);
    // The house rule for every bearer value in this schema. If the plain
    // challenge ever reached a column, a database dump would carry live
    // credentials for two minutes each.
    expect(JSON.stringify(fila)).not.toContain(RETO);
  });

  it("keeps the purpose and the ownership the caller stated", async () => {
    await guardarReto(RETO, "segundo_factor", { id_usuario: 7, id_sesion: "s-1" });

    expect(create.mock.calls[0][0]).toMatchObject({
      proposito: "segundo_factor",
      id_usuario: 7,
      id_sesion: "s-1",
    });
  });

  // 🔴 The passwordless ceremony. Both nulls have to survive the write, or
  // phase 2 has nowhere to put its challenge — which is the entire reason this
  // table exists instead of two columns on `sesiones`.
  it("accepts a ceremony that belongs to nobody yet", async () => {
    await guardarReto(RETO, "login", { id_usuario: null, id_sesion: null });

    expect(create.mock.calls[0][0]).toMatchObject({ id_usuario: null, id_sesion: null });
  });

  it("expires it two minutes out, from the configured window and not a literal", async () => {
    const antes = Date.now();
    await guardarReto(RETO, "registro", { id_usuario: 7, id_sesion: "s-1" });
    const despues = Date.now();

    const { expires_at } = create.mock.calls[0][0] as { expires_at: Date };
    // A range rather than an equality, because the clock moves between the two
    // reads. Read off the constant so changing the window moves this test with
    // it instead of against it.
    expect(expires_at.getTime()).toBeGreaterThanOrEqual(antes + WEBAUTHN_CHALLENGE_TTL_MS);
    expect(expires_at.getTime()).toBeLessThanOrEqual(despues + WEBAUTHN_CHALLENGE_TTL_MS);
  });

  it("carries the caller's transaction so the write commits or fails with theirs", async () => {
    const transaction = { id: "t" } as never;
    await guardarReto(RETO, "registro", { id_usuario: 7, id_sesion: "s-1", transaction });

    expect(create.mock.calls[0][1]).toMatchObject({ transaction });
  });
});

describe("consumirReto — one statement, which is the whole guarantee", () => {
  // 🔴 The finding this shape exists for (B6, already made once in this
  // repository): a `SELECT` that checks the challenge is unspent, followed by
  // an `UPDATE` that spends it, lets two requests carrying the **same captured
  // assertion** both read "unspent" and both proceed. For a synced passkey —
  // iCloud Keychain, Google Password Manager, which report a signature counter
  // of 0 forever — there is no clone detection behind this to catch it.
  it("never reads before it writes", async () => {
    await consumirReto(RETO, "login", { id_sesion: null });

    expect(update).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
  });

  it("puts every condition inside that one WHERE, with the right operators", async () => {
    await consumirReto(RETO, "segundo_factor", { id_sesion: "s-9" });

    const opciones = update.mock.calls[0][1] as {
      where: Record<string | symbol, unknown>;
      returning?: boolean;
    };
    expect(opciones.where.reto_hash).toBe(HASH);
    // Purpose inside the clause, not compared afterwards: a challenge minted
    // to register a credential must not complete an authentication, and a
    // check that runs after the row is already marked spent has lost.
    expect(opciones.where.proposito).toBe("segundo_factor");
    expect(opciones.where.id_sesion).toBe("s-9");
    // Equality against NULL, not "already spent" written as a follow-up read
    // a concurrent request could race past.
    expect(opciones.where.used_at).toBeNull();
    // `Op.gt`, and asserted as the operator rather than as "expires_at is in
    // there": `Op.lt` would accept exactly the expired challenges this
    // condition exists to refuse, and a presence check would not notice.
    expect(opciones.where.expires_at).toEqual({ [Op.gt]: expect.any(Date) });
    expect(opciones.returning).toBe(true);
  });

  // 🔴 The condition an optional parameter would silently drop. If `id_sesion`
  // were omissible, forgetting it would remove this line from the clause and a
  // challenge minted for one session would become spendable from any session
  // that got hold of it. An omitted argument must not be able to widen a
  // security check.
  it("still constrains the session when the ceremony has none", async () => {
    await consumirReto(RETO, "login", { id_sesion: null });

    const opciones = update.mock.calls[0][1] as { where: Record<string, unknown> };
    expect("id_sesion" in opciones.where).toBe(true);
    expect(opciones.where.id_sesion).toBeNull();
  });

  it("answers null for every failure without saying which", async () => {
    update.mockResolvedValue([0, []]);
    // Expired, already spent, wrong purpose, wrong session, never existed —
    // one answer. Rule B12: a caller who can tell them apart can map what
    // exists.
    expect(await consumirReto(RETO, "login", { id_sesion: null })).toBeNull();
  });

  it("hands back who the challenge belonged to when it spends one", async () => {
    update.mockResolvedValue([1, [{ dataValues: { id_usuario: 7, id_sesion: "s-1" } }]]);

    expect(await consumirReto(RETO, "segundo_factor", { id_sesion: "s-1" })).toEqual({
      id_usuario: 7,
      id_sesion: "s-1",
    });
  });

  // The passwordless case again, from the redeeming side: the row is the only
  // thing that knows who this is, and it says nobody until the assertion
  // itself names a credential.
  it("hands back a null owner for the passwordless ceremony", async () => {
    update.mockResolvedValue([1, [{ dataValues: { id_usuario: null, id_sesion: null } }]]);

    expect(await consumirReto(RETO, "login", { id_sesion: null })).toEqual({
      id_usuario: null,
      id_sesion: null,
    });
  });
});

describe("purgarRetosCaducados", () => {
  it("deletes the spent and the expired, and nothing else", async () => {
    await purgarRetosCaducados();

    const where = destroy.mock.calls[0][0].where as Record<symbol, unknown[]>;
    // Both operators asserted exactly. `Op.ne: null` is "has been spent";
    // `Op.lte` on expiry is "its window has closed". `Op.gte` there would
    // delete the live ones, which is every ceremony in flight.
    expect(where[Op.or]).toEqual([
      { used_at: { [Op.ne]: null } },
      { expires_at: { [Op.lte]: expect.any(Date) } },
    ]);
  });
});
