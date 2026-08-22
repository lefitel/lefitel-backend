// The front door.
//
// The rules about whitespace here are two different decisions that look like
// one, and getting them backwards is a classic: a username is a name for a row
// and its edges do not matter, a password is a secret and every character in it
// does. This file exists so nobody "tidies up" the second one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findOne = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findOne: (...args: unknown[]) => findOne(...args) },
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
  return { dataValues: { id: 1, id_rol: 1, user, pass: "$2a$08$hash", name: "I", lastname: "S", image: null } };
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
