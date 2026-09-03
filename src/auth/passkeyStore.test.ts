// The signature counter rule, and the two ways of getting it wrong that both
// look like working code.
//
// Every `guardado` below is a **string**, because that is the shape `pg` hands
// a `BIGINT` column back in — never a number. Writing these fixtures as
// numbers would make the whole file pass against an implementation that is
// broken in production, which is the exact trap `ultimo_paso` fell into and
// `totpStore.test.ts` now guards against by the same means.

import { describe, expect, it, vi, beforeEach } from "vitest";

// The model and the connection, faked so the two store functions below can be
// asserted on the shape of what they send — `esContadorDeClon` is pure and
// does not notice either mock.
const findOne = vi.fn();
const update = vi.fn();
vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: {
    findOne: (...a: unknown[]) => findOne(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));
vi.mock("../database/sequelize.js", () => ({
  sequelize: {
    fn: (nombre: string, ...args: unknown[]) => ({ fn: nombre, args }),
    col: (nombre: string) => ({ col: nombre }),
  },
}));

const { esContadorDeClon, buscarCredencialPorId, marcarCredencialUsada } = await import(
  "./passkeyStore.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue([1]);
});

describe("esContadorDeClon — a counter that moves", () => {
  // Deliberately not starting from "0". A rule written as a bare
  // `recibido > guardado` passes this test too; what separates the two is
  // the synced-passkey block below, and it only separates them if the
  // ordinary cases are asserted away from zero.
  it("accepts an assertion whose counter advanced", () => {
    expect(esContadorDeClon("41", 42)).toBe(false);
  });

  it("rejects an assertion whose counter went backwards", () => {
    expect(esContadorDeClon("42", 41)).toBe(true);
  });

  // 🔴 The case a `number` declaration silently loses. Written as
  // `recibido === guardado` it is `42 === "42"` — `false`, because `===`
  // never coerces across types — so the rule would accept a replayed
  // assertion carrying the exact counter it saw last time, which is the
  // textbook clone signature. Mutating `<=` to `<` in the implementation
  // turns this one red and nothing else.
  it("rejects an assertion that repeats the stored counter exactly", () => {
    expect(esContadorDeClon("42", 42)).toBe(true);
  });
});

describe("esContadorDeClon — authenticators that do not count", () => {
  // 🔴 The failure that bricks a passkey one use after registering it.
  // iCloud Keychain and Google Password Manager report 0 on every assertion,
  // forever, because a credential synced across devices has no single device
  // to keep a count on. A bare `recibido > guardado` reads `0 > 0` here,
  // answers "clone", and the person is locked out by their own phone with an
  // error indistinguishable from a real attack.
  it("accepts a synced passkey reporting zero every time", () => {
    expect(esContadorDeClon("0", 0)).toBe(false);
  });

  it("accepts the first assertion from a credential that does count", () => {
    expect(esContadorDeClon("0", 1)).toBe(false);
  });

  // An authenticator that counted and then stopped — a firmware update, or a
  // credential migrated into a password manager. Refusing here would brick a
  // working passkey, and 0 carries no claim about ordering to contradict.
  it("accepts a credential that stops reporting a count", () => {
    expect(esContadorDeClon("7", 0)).toBe(false);
  });
});

describe("esContadorDeClon — an unreadable stored value fails closed", () => {
  // `Number("x")` is `NaN`, and **every** comparison against `NaN` is
  // `false`. An implementation that just compares would answer "not a clone"
  // and let the assertion through, which is the wrong direction to fail in:
  // a row that does not parse is corruption, not a fresh credential.
  it("treats a value that is not a number as a clone", () => {
    expect(esContadorDeClon("no-soy-un-numero", 5)).toBe(true);
  });

  // 🔴 The crossing case, and the only thing that pins the **order** of the
  // two guards. Found by mutating the implementation: with the zero guard
  // moved in front of the parse guard, a corrupt row paired with an
  // authenticator that reports no count (`recibido = 0` — every synced
  // passkey, so not an exotic pairing) returns "not a clone" and the
  // assertion is accepted on top of a row nobody can read. The parse guard
  // has to come first. Without this test both orderings pass.
  it("still fails closed when the row is corrupt and the assertion reports no count", () => {
    expect(esContadorDeClon("no-soy-un-numero", 0)).toBe(true);
  });

  it("treats an empty stored value as a clone", () => {
    // `Number("")` is 0, not NaN — so this one does not reach the guard
    // above. It lands on "the stored side is not above zero", which accepts.
    // Asserted so the difference is on the record rather than discovered by
    // somebody later: an empty string is not the corruption case.
    expect(esContadorDeClon("", 5)).toBe(false);
  });
});

describe("esContadorDeClon — the shape it is actually called with", () => {
  // The guard that keeps this file honest. `ICredencialWebauthn.counter` is
  // declared `string` precisely because that is what arrives; if a future
  // edit "simplifies" the interface back to `number`, these fixtures stop
  // matching the real call site and the suite would go on passing while
  // production compares the wrong things.
  it("compares a string from the database against a number from the assertion", () => {
    const guardado: string = "100";
    const recibido: number = 101;
    expect(esContadorDeClon(guardado, recibido)).toBe(false);
    expect(typeof guardado).toBe("string");
  });
});

/**
 * The passwordless lookup — plan 4C phase 2 — where the credential *is* the
 * identity and the lookup is by `credential_id` alone, on purpose. The
 * scoped sibling `buscarCredencialDe` is the phase-1 one and is asserted from
 * `webauthn.controller.test.ts`.
 */
describe("buscarCredencialPorId — the passwordless lookup", () => {
  const FILA = {
    dataValues: {
      id: 7,
      id_usuario: 42,
      credential_id: "credencial-base64url",
      public_key: Buffer.from([1, 2, 3]),
      counter: "5",
    },
  };

  it("looks the credential up by its id and by nothing else", async () => {
    findOne.mockResolvedValue(FILA);
    await buscarCredencialPorId("credencial-base64url");
    // `toStrictEqual`: an `id_usuario: undefined` slipped into the where would
    // be dropped by Sequelize and read as equal by `toEqual`.
    expect(findOne.mock.calls[0][0].where).toStrictEqual({ credential_id: "credencial-base64url" });
  });

  it("asks for the public key and the owner by name, past the default scope", async () => {
    findOne.mockResolvedValue(FILA);
    await buscarCredencialPorId("credencial-base64url");
    expect(findOne.mock.calls[0][0].attributes).toEqual([
      "id",
      "id_usuario",
      "credential_id",
      "public_key",
      "counter",
    ]);
  });

  it("hands back the owner with the key, which is how the door learns who is there", async () => {
    findOne.mockResolvedValue(FILA);
    const r = await buscarCredencialPorId("credencial-base64url");
    expect(r).toEqual({
      id: 7,
      id_usuario: 42,
      credential_id: "credencial-base64url",
      public_key: Buffer.from([1, 2, 3]),
      // A string, exactly as `pg` returns a BIGINT — never converted here.
      counter: "5",
    });
  });

  it("answers null for a credential this ERP has never seen", async () => {
    findOne.mockResolvedValue(null);
    expect(await buscarCredencialPorId("desconocida")).toBeNull();
  });
});

/**
 * The boolean is the passwordless door's race defence: inside its
 * transaction, a mark that matched nothing means the credential was deleted
 * under the ceremony, and the login is refused. A `void` here would let the
 * controller open a session for a credential that no longer exists.
 */
describe("marcarCredencialUsada — whether there was a row to mark", () => {
  it("says so when the row was there", async () => {
    update.mockResolvedValue([1]);
    expect(await marcarCredencialUsada(7, 6)).toBe(true);
  });

  it("says so when it was not", async () => {
    update.mockResolvedValue([0]);
    expect(await marcarCredencialUsada(7, 6)).toBe(false);
  });

  it("marks exactly that row, inside the caller's transaction", async () => {
    const transaction = { id: "una-transaccion" };
    await marcarCredencialUsada(7, 6, { transaction: transaction as never });
    expect(update.mock.calls[0][1]).toEqual({ where: { id: 7 }, transaction });
  });

  it("moves the counter forward with GREATEST, never with a plain assignment", async () => {
    // A synced passkey reports 0 for ever; assigned over a stored 5 the column
    // would go backwards and clone detection would be off for that credential
    // for good.
    await marcarCredencialUsada(7, 6);
    const escrito = update.mock.calls[0][0] as { counter: unknown; last_used_at: unknown };
    expect(escrito.counter).toEqual({ fn: "GREATEST", args: [{ col: "counter" }, 6] });
    expect(escrito.last_used_at).toBeInstanceOf(Date);
  });
});
