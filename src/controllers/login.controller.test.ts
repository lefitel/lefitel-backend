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
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...args: unknown[]) => findOne(...args),
    update: (...args: unknown[]) => update(...args),
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

  it("records a failure and escalates the wait on a wrong password", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = 2;
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(update).toHaveBeenCalledWith({ failed_attempts: 3, locked_until: null }, { where: { id: 1 } });
  });

  it("locks the account once the failure threshold is reached", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = LOCKOUT_AFTER_FAILURES - 1;
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "x" });
    await loginUsuario(c.req, c.res);

    const [update_args, where] = update.mock.calls[0] as [
      { failed_attempts: number; locked_until: Date | null },
      { where: { id: number } },
    ];
    expect(update_args.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES);
    expect(update_args.locked_until).toBeInstanceOf(Date);
    expect(where.where.id).toBe(1);
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
    // something to clear.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    findOne.mockResolvedValue(storedUser());
    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });
});
