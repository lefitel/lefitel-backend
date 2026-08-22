// The front door.
//
// The rules about whitespace here are two different decisions that look like
// one, and getting them backwards is a classic: a username is a name for a row
// and its edges do not matter, a password is a secret and every character in it
// does. This file exists so nobody "tidies up" the second one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { CREDENCIALES_INVALIDAS, LOCKOUT_AFTER_FAILURES } from "../config/security.js";

const findOne = vi.fn();
// `update` is exposed alongside `findOne` so the lockout bookkeeping — recording
// a failure, escalating the wait, clearing the slate on success — can be
// asserted on directly instead of only inferred from the response.
const update = vi.fn();
// `increment` is the atomic write a wrong password now makes: `UPDATE ... SET
// failed_attempts = failed_attempts + 1` done by the database, not a
// read-in-Node-then-write-back that a race can lose a count to. Exposed as
// its own spy so tests can assert the atomic path was actually taken, not
// just infer it from the response.
const increment = vi.fn().mockResolvedValue(undefined);
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...args: unknown[]) => findOne(...args),
    update: (...args: unknown[]) => update(...args),
    increment: (...args: unknown[]) => increment(...args),
  },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));
vi.mock("jsonwebtoken", () => ({ default: { sign: () => "un.token.firmado" } }));
vi.mock("../permissions/store.js", () => ({ permissionsFor: async () => ({}) }));

const { loginUsuario } = await import("./login.controller.js");

/** A stored account whose password is whatever the test says it is. */
function storedUser(user = "isaias") {
  return {
    dataValues: {
      id: 1,
      id_rol: 1,
      user,
      pass: "$2a$08$hash",
      name: "I",
      lastname: "S",
      image: null,
      // Matching the model's own defaults (see usuario.model.ts): a fresh
      // account has never failed and is never locked.
      failed_attempts: 0,
      locked_until: null as Date | null,
    },
  };
}

function call(body: unknown) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return {
    req: { body, ip: "::1", headers: {} } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
  };
}

/** The username the lookup actually went looking for. */
const searchedFor = () => (findOne.mock.calls[0][0] as { where: { user: string } }).where.user;

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(storedUser());
});

describe("the username", () => {
  it("loses the spaces at its ends", async () => {
    // Pasting a username picks up a trailing space more often than anyone
    // admits, and the answer was "usuario inexistente" with nothing on screen
    // explaining why.
    const c = call({ user: "  isaias  ", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(searchedFor()).toBe("isaias");
    expect(c.status).toBe(200);
  });

  it("keeps the spaces inside it", async () => {
    // `Omar Mita` is a real account in this database. Stripping spaces rather
    // than trimming them would lock him out.
    findOne.mockResolvedValue(storedUser("Omar Mita"));
    const c = call({ user: " Omar Mita ", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(searchedFor()).toBe("Omar Mita");
    expect(c.status).toBe(200);
  });

  it("is refused when it is nothing but spaces", async () => {
    const c = call({ user: "     ", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("is refused when it is not a string at all", async () => {
    // Sequelize reads an object in `where` as a set of conditions, so a body
    // like {"user": {"ne": null}} must never reach the query as a value.
    for (const user of [{ ne: null }, ["isaias"], 7, null, undefined]) {
      vi.clearAllMocks();
      const c = call({ user, pass: "secreta" });
      await loginUsuario(c.req, c.res);

      expect(c.status, JSON.stringify(user)).toBe(400);
      expect(findOne, JSON.stringify(user)).not.toHaveBeenCalled();
    }
  });
});

describe("the password", () => {
  it("is compared exactly as it was typed", async () => {
    // The one that must not be "tidied". Trimming would accept a different
    // secret than the one chosen and shrink what an attacker has to guess.
    const bcryptjs = (await import("bcryptjs")).default;
    const c = call({ user: "isaias", pass: "  con espacios  " });
    await loginUsuario(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("  con espacios  ", "$2a$08$hash");
  });

  it("keeps a password that is only spaces intact rather than emptying it", async () => {
    // Absurd as a password and still not ours to rewrite. The browser refuses
    // to send it; if one arrives it is compared, not trimmed into "".
    const bcryptjs = (await import("bcryptjs")).default;
    const c = call({ user: "isaias", pass: "   " });
    await loginUsuario(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("   ", "$2a$08$hash");
  });

  it("is refused when it is empty", async () => {
    const c = call({ user: "isaias", pass: "" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("is refused when it is not a string at all", async () => {
    const c = call({ user: "isaias", pass: { ne: null } });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("what comes back", () => {
  it("never includes the stored hash", async () => {
    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(JSON.stringify(c.res)).not.toContain("$2a$08$hash");
  });

  it("says the same thing whether the user is unknown or the password is wrong", async () => {
    // Two different messages tell an attacker which usernames exist. This used
    // to be a known gap pinned as such; it is closed now and the assertion is
    // the other way round.
    const bcryptjs = (await import("bcryptjs")).default;

    findOne.mockResolvedValue(null);
    const unknown = call({ user: "nadie", pass: "x" });
    await loginUsuario(unknown.req, unknown.res);

    findOne.mockResolvedValue(storedUser());
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const wrong = call({ user: "isaias", pass: "x" });
    await loginUsuario(wrong.req, wrong.res);

    expect(unknown.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(unknown.message).toBe(wrong.message);
  });

  it("hashes even when the account does not exist", async () => {
    // The message being equal is half of it. Without a comparison against a
    // filler hash the unknown path returns in a millisecond and the known one
    // in two hundred and fifty, and a stopwatch enumerates the payroll. Just
    // asserting that `compare` was called would pass even if it compared
    // against the wrong thing — an empty string, say — so the second
    // argument is pinned to what the mocked `bcryptjs.hash` actually
    // produces ("hashed", from the mock above), which is the value
    // `fillerHash()` resolves to.
    const bcryptjs = (await import("bcryptjs")).default;

    findOne.mockResolvedValue(null);
    const c = call({ user: "nadie", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("x", "hashed");
  });

  it("quietly re-hashes a password stored at the old cost", async () => {
    // Raising the cost only helps passwords hashed after the change. Every
    // existing account would keep its cost-8 hash for as long as nobody changed
    // it — which, for an internal ERP, is forever. So a successful login pays
    // one extra hash and the account moves up.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(bcryptjs.hash).toHaveBeenCalledWith("secreta", 12);
  });

  it("re-hashes a hash stored at cost 10 or 11, not only the historical 8", async () => {
    // The detection reads the cost back out of the hash and compares it to
    // BCRYPT_COST, rather than testing for one specific old prefix like
    // `$2a$08$`. A fixed-prefix check would only ever catch that one value —
    // a row sitting at 10 or 11 would pass through untouched, silently.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const user = storedUser();
    user.dataValues.pass = "$2a$10$hash";
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(bcryptjs.hash).toHaveBeenCalledWith("secreta", 12);
  });

  it("leaves a hash already at or above the current cost alone", async () => {
    // The other direction of the same comparison: a hash that is not below
    // BCRYPT_COST must not be touched, including one above it — the
    // constant might move down again someday, and this is not the place
    // that decides that.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const user = storedUser();
    user.dataValues.pass = "$2a$14$hash";
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(bcryptjs.hash).not.toHaveBeenCalled();
  });
});

describe("account lockout", () => {
  it("says the same thing, with the same status, whether the account is locked or the password is simply wrong", async () => {
    // A lockout that answered differently from a wrong password would be a
    // second oracle, right next to the one the uniform message just closed —
    // this time naming which accounts are locked instead of which exist.
    const bcryptjs = (await import("bcryptjs")).default;

    const locked = storedUser();
    locked.dataValues.locked_until = new Date(Date.now() + 60_000);
    findOne.mockResolvedValue(locked);
    const lockedCall = call({ user: "isaias", pass: "x" });
    await loginUsuario(lockedCall.req, lockedCall.res);

    findOne.mockResolvedValue(storedUser());
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const wrong = call({ user: "isaias", pass: "x" });
    await loginUsuario(wrong.req, wrong.res);

    expect(lockedCall.status).toBe(400);
    expect(lockedCall.message).toBe(CREDENCIALES_INVALIDAS);
    expect(wrong.status).toBe(lockedCall.status);
    expect(wrong.message).toBe(lockedCall.message);
  });

  it("pays the filler hash while locked, instead of returning before it", async () => {
    // The message being equal is half of it, same as for the unknown-user
    // path above. A locked account that skipped the hash would answer in a
    // millisecond next to a wrong password's two hundred and fifty — the
    // lockout would be the fast path this time, and just as measurable.
    const bcryptjs = (await import("bcryptjs")).default;

    const locked = storedUser();
    locked.dataValues.locked_until = new Date(Date.now() + 60_000);
    findOne.mockResolvedValue(locked);
    const c = call({ user: "isaias", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("x", "hashed");
    expect(bcryptjs.compare).not.toHaveBeenCalledWith("x", locked.dataValues.pass);
  });

  it("does not touch the account row while it is locked", async () => {
    // The lockout is read-only on the way in: only a real attempt against the
    // real hash below is allowed to change failed_attempts or locked_until.
    const locked = storedUser();
    locked.dataValues.locked_until = new Date(Date.now() + 60_000);
    findOne.mockResolvedValue(locked);
    const c = call({ user: "isaias", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(update).not.toHaveBeenCalled();
  });

  it("records a failure through an atomic increment, not a computed update", async () => {
    // The lookup's own `findOne` returns the account as it was before this
    // request; the second `findOne` below stands in for the re-read that
    // follows the atomic increment in `login.controller.ts`, returning the
    // count the database actually holds afterwards.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = 2;
    findOne.mockResolvedValueOnce(user).mockResolvedValueOnce({ dataValues: { failed_attempts: 3 } });

    const c = call({ user: "isaias", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: 1 } });
    // Below the threshold, there is nothing to lock, so no `update` call at
    // all — the count already lives correctly in the database via the
    // increment above.
    expect(update).not.toHaveBeenCalled();
  });

  it("locks the account once the failure threshold is reached, writing only locked_until", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = LOCKOUT_AFTER_FAILURES - 1;
    findOne
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ dataValues: { failed_attempts: LOCKOUT_AFTER_FAILURES } });

    const c = call({ user: "isaias", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: 1 } });
    expect(update).toHaveBeenCalledTimes(1);
    const [values, where] = update.mock.calls[0] as [{ locked_until: Date | null }, { where: { id: number } }];
    expect(values.locked_until).toBeInstanceOf(Date);
    // failed_attempts must never be in this call: it is already correct in
    // the database from the increment, and writing a value read a moment
    // earlier would reopen the same race under a narrower window.
    expect(values).not.toHaveProperty("failed_attempts");
    expect(where.where.id).toBe(1);
  });

  it("still counts each wrong guess when two arrive at the same time", async () => {
    // The regression this guards against: `UsuarioModel.update({
    // failed_attempts: (data.failed_attempts ?? 0) + 1, ... })` reads the
    // count, adds one in Node, and writes it back. Two requests racing
    // through that pattern both read the same starting count and both
    // write back the same +1 — one of the two failures is lost. This test
    // cannot observe database row state directly, but it can and does
    // assert that *each* request independently reaches the atomic
    // increment; if the code reverted to computing the count itself,
    // `increment` would never be called at all, and this fails.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    // Every read, in both requests, sees the account before either has
    // written anything back — the exact interleaving that loses a count
    // under the old pattern.
    findOne.mockResolvedValue(storedUser());

    const a = call({ user: "isaias", pass: "x" });
    const b = call({ user: "isaias", pass: "y" });
    await Promise.all([loginUsuario(a.req, a.res), loginUsuario(b.req, b.res)]);

    expect(increment).toHaveBeenCalledTimes(2);
    expect(increment).toHaveBeenNthCalledWith(1, "failed_attempts", { where: { id: 1 } });
    expect(increment).toHaveBeenNthCalledWith(2, "failed_attempts", { where: { id: 1 } });
  });

  it("clears the failure count on a correct password", async () => {
    // Earlier tests in this file leave `bcryptjs.compare` mocked to resolve
    // `false`; `vi.clearAllMocks()` in `beforeEach` clears call history but
    // not that resolved value, so it has to be pinned back here rather than
    // relying on the module's default mock.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const user = storedUser();
    user.dataValues.failed_attempts = 4;
    user.dataValues.locked_until = null;
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ failed_attempts: 0, locked_until: null }, { where: { id: 1 } });
  });

  it("does not write to the account row on a correct password that had a clean record", async () => {
    // A write on every successful login would be a database hit nobody asked
    // for. The bookkeeping only has something to clear when there is
    // something to clear. Stored at the current cost, deliberately: this is
    // about the failed-attempts bookkeeping, not about the re-hash above —
    // an old-cost hash would trigger that other write and confuse the two.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const clean = storedUser();
    clean.dataValues.pass = "$2a$12$hash";
    findOne.mockResolvedValue(clean);
    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });
});
