// `verifyCredentials` — the front door's credential net.
//
// The rules about whitespace here are two different decisions that look like
// one, and getting them backwards is a classic: a username is a name for a row
// and its edges do not matter, a password is a secret and every character in it
// does. This file exists so nobody "tidies up" the second one.
//
// **Why it is named after `credentials.ts` and not after a controller.** It was
// `controllers/login.controller.test.ts` for as long as there was a
// `login.controller.ts` to test: these assertions went in through
// `loginUsuario`, that file's own handler for `POST /api/login`. Two plans later
// the handler was merged into `auth.controller.ts`'s `login` and the controller
// was deleted, and the name had stopped describing anything — every decision
// asserted below lives in `verifyCredentials`, which had no test file of its
// own while its 32 cases sat under the name of a file that no longer existed.
//
// **Why it still calls the handler rather than `verifyCredentials` directly.**
// Because `login` is that function's only caller, and going in through it
// asserts the mapping as well as the rule: a lockout that `verifyCredentials`
// reports correctly and the handler answers 200 to is not a lockout. The status
// codes below are the handler's; everything they are checking is underneath it.
// Calling the function directly would trade that for nothing — there is no
// second caller for the two to disagree about.
//
// The overlap with `controllers/auth.controller.test.ts` is deliberate and
// small: three of its cases (a locked account, a wrong password, an empty body)
// travel this same real `verifyCredentials`, and they are there to pin that the
// controller reuses this and has not grown a copy. The exhaustive version is
// here.

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
// `jsonwebtoken` is deliberately **not** mocked, and the absence is a tripwire
// rather than an omission — the same one `login.session.test.ts` sets. The mock
// was `{ verify }` while `comprobarToken` was tested from this file; it lost
// `sign` when the login stopped signing, and lost the rest when the verifier was
// retired. Nothing on this path touches the library now, so there is nothing to
// stub: put a `jwt.sign` or a `jwt.verify` back into the login and it runs
// against the real module and whatever `JWT_SECRET` this environment has,
// instead of quietly meeting a stub that absorbs it.
vi.mock("../permissions/store.js", () => ({ permissionsFor: async () => ({}) }));
// Opening the session cookie is not what this file is about, and it cannot be
// left real: `issueSession` reaches `sesion.model.ts`, which calls
// `UsuarioModel.hasMany` while it is being imported — on the stub above, which
// has no such method, so the whole suite would fail to load before running a
// single assertion. `authenticate.test.ts` mocks the session store for the same
// reason. What the login does with the cookie is asserted in
// `controllers/login.session.test.ts`, where `issueSession` is real.
vi.mock("./issueSession.js", () => ({ issueSession: vi.fn() }));
// The store as well, and mocking `issueSession` above is not enough to avoid it:
// `auth.controller.ts` imports these three names for its *other* five
// endpoints, none of which this file calls, and that import alone is what pulls
// `sesion.model.ts` and its `UsuarioModel.hasMany` in. Without this the whole
// suite fails to load with "UsuarioModel.hasMany is not a function", which is
// exactly the failure the note above predicts and the reason it is written down.
vi.mock("./sessionStore.js", () => ({
  listSessionsOf: vi.fn(),
  revokeAllSessionsOf: vi.fn(),
  revokeSessionOf: vi.fn(),
}));
// Same failure, same fix, for the fourth thing `auth.controller.ts` imports:
// `tokenStore.js` reaches `tokenUsoUnico.model.ts`, which also calls
// `UsuarioModel.hasMany` on import — on the same insufficient stub above.
// `login` calls this opportunistically after a successful credential check
// (see `tokenStore.ts`), which is no part of what this file is testing.
vi.mock("./tokenStore.js", () => ({ purgeExpiredTokens: vi.fn().mockResolvedValue(0) }));
// And the fifth, for the same reason and one more. `auth.controller.ts` now
// asks `estadoInicialDeSesion` which state the session should open in, and
// that module imports the three factor models — each of which calls
// `UsuarioModel.hasMany` on import, on the same stub above that does not have
// it. Mocked rather than given three more model stubs because which state a
// session opens in is not what this file is about: it is
// `auth/factorInventory.test.ts`'s subject, and the wiring between the two is
// `controllers/login.session.test.ts`'s.
//
// `graceUntil: null` on purpose. A date here would make every successful login
// in this file write `mfa_grace_until`, and three tests below assert that
// `UsuarioModel.update` was *not* called — they are about the credential check
// touching nothing, and a grace write landing in the same spy would break them
// for a reason that has nothing to do with what they test.
vi.mock("./factorInventory.js", () => ({
  estadoInicialDeSesion: vi.fn().mockResolvedValue({ estado: "completa", graceUntil: null }),
}));
// And the sixth. `logoutAll` now also revokes remembered devices (see its own
// comment), so `auth.controller.ts` imports `rememberedDeviceStore.js`, which
// reaches `dispositivoRecordado.model.ts` — one more caller of
// `UsuarioModel.hasMany` on the same insufficient stub above. `login`, the one
// endpoint this file exercises, never touches a remembered device at all.
vi.mock("./rememberedDeviceStore.js", () => ({ revokeAllRememberedDevicesOf: vi.fn() }));

// The handler both `POST /api/login` and `POST /api/auth/login` are mounted on.
const { login } = await import("../controllers/auth.controller.js");

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
    // `handler()` in `auth.controller.ts` reads this before writing its 500, so
    // the stub carries it rather than leaving it undefined by luck.
    headersSent: false,
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

/**
 * The `where` the lookup actually went looking with.
 *
 * Not `where.user` any more: the lookup compares `lower("user")`, the same way
 * `usuarios_user_uniq` and the per-account rate-limit bucket do, so what arrives
 * here is a Sequelize `Where` object rather than a plain field. The shape is
 * asserted rather than trusted — `looksCaseFolded` below is what fails if
 * somebody puts `{ where: { user } }` back.
 */
const searchedWith = () => (findOne.mock.calls[0][0] as { where: unknown }).where;

/** The name the lookup compared against, after folding. */
const searchedFor = () => (searchedWith() as { logic?: unknown }).logic;

/** `lower("user") = <something>`, which is what the unique index indexes. */
const looksCaseFolded = { attribute: { fn: "lower", args: [{ col: "user" }] }, comparator: "=" };

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
    await login(c.req, c.res);

    expect(searchedFor()).toBe("isaias");
    expect(c.status).toBe(200);
  });

  it("keeps the spaces inside it", async () => {
    // `Omar Mita` is a real account in this database. Stripping spaces rather
    // than trimming them would lock him out.
    findOne.mockResolvedValue(storedUser("Omar Mita"));
    const c = call({ user: " Omar Mita ", pass: "secreta" });
    await login(c.req, c.res);

    // Lower-cased by the lookup, so "omar mita" — with the space still in it,
    // which is the part this test is about.
    expect(searchedFor()).toBe("omar mita");
    expect(c.status).toBe(200);
  });

  it("finds an account whose stored name has capitals, typed in lower case", async () => {
    // The gap this closes. Three places folded case — the unique index on
    // `lower("user")`, the per-account rate-limit bucket, the username
    // collision check — and this lookup compared bytes. So `Omar Mita`, a real
    // account, typing `omar mita` fell into the unknown-user branch and got
    // "Usuario o contraseña incorrectos", which since the message became
    // uniform is exactly what a wrong password gets. He retried, and after ten
    // tries the bucket answered 429. No way in, and nothing saying why — and no
    // way round it either, because the collision check would refuse him the
    // lower-case name as already taken.
    findOne.mockResolvedValue(storedUser("Omar Mita"));
    const c = call({ user: "omar mita", pass: "secreta" });
    await login(c.req, c.res);

    expect(searchedWith()).toMatchObject({ ...looksCaseFolded, logic: "omar mita" });
    expect(c.status).toBe(200);
  });

  it("looks for one and the same account however it was capitalised", async () => {
    // The shape assertion above says the query mentions `lower`. This says the
    // *value* is folded too: a query of `lower("user") = 'Omar Mita'` matches
    // nothing at all and would satisfy the shape perfectly.
    for (const typed of ["Omar Mita", "OMAR MITA", "omar mita", " oMaR mItA "]) {
      vi.clearAllMocks();
      findOne.mockResolvedValue(storedUser("Omar Mita"));
      const c = call({ user: typed, pass: "secreta" });
      await login(c.req, c.res);

      expect(searchedFor(), typed).toBe("omar mita");
      expect(c.status, typed).toBe(200);
    }
  });

  it("is refused when it is nothing but spaces", async () => {
    const c = call({ user: "     ", pass: "secreta" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("is refused when it is not a string at all", async () => {
    // Sequelize reads an object in `where` as a set of conditions, so a body
    // like {"user": {"ne": null}} must never reach the query as a value.
    for (const user of [{ ne: null }, ["isaias"], 7, null, undefined]) {
      vi.clearAllMocks();
      const c = call({ user, pass: "secreta" });
      await login(c.req, c.res);

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
    await login(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("  con espacios  ", "$2a$08$hash");
  });

  it("keeps a password that is only spaces intact rather than emptying it", async () => {
    // Absurd as a password and still not ours to rewrite. The browser refuses
    // to send it; if one arrives it is compared, not trimmed into "".
    const bcryptjs = (await import("bcryptjs")).default;
    const c = call({ user: "isaias", pass: "   " });
    await login(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("   ", "$2a$08$hash");
  });

  it("is refused when it is empty", async () => {
    const c = call({ user: "isaias", pass: "" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("is refused when it is not a string at all", async () => {
    const c = call({ user: "isaias", pass: { ne: null } });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("what comes back", () => {
  it("never includes the stored hash", async () => {
    const c = call({ user: "isaias", pass: "secreta" });
    await login(c.req, c.res);

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
    await login(unknown.req, unknown.res);

    findOne.mockResolvedValue(storedUser());
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const wrong = call({ user: "isaias", pass: "x" });
    await login(wrong.req, wrong.res);

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
    await login(c.req, c.res);

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
    await login(c.req, c.res);

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
    await login(c.req, c.res);

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
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(bcryptjs.hash).not.toHaveBeenCalled();
  });
});

/**
 * How long each way of failing takes, which is a channel of its own.
 *
 * The message is uniform and the status is uniform. The clock was not: raising
 * bcrypt from 8 to 12 made the filler hash — paid on the unknown-name and
 * locked-account paths — twelve times more expensive than the comparison
 * against a stored hash that is still at 8, which is every account in this
 * database until its owner next logs in successfully. Measured on this machine:
 * 228 ms for an unknown name, 19 ms for a wrong password against a real
 * account. Two attempts and a median tell an attacker which names exist, and
 * two is under the lockout threshold, so nobody gets locked while it happens.
 *
 * These tests count `compare` calls, which is the only thing a unit test can
 * see of a duration. Deleting the extra compare in `auth/credentials.ts` — it
 * looks exactly like a pointless one — fails the first of them.
 */
describe("what a failure costs", () => {
  it("pays a second hash when the stored one is cheaper than the current cost", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    findOne.mockResolvedValue(storedUser()); // stored at cost 8, like every real row

    const c = call({ user: "isaias", pass: "x" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(bcryptjs.compare).toHaveBeenCalledWith("x", "$2a$08$hash");
    // "hashed" is what the mocked `bcryptjs.hash` returns, so it is what
    // `fillerHash()` resolves to — the same value the unknown-user and
    // locked-account paths compare against.
    expect(bcryptjs.compare).toHaveBeenCalledWith("x", "hashed");
    expect(bcryptjs.compare).toHaveBeenCalledTimes(2);
  });

  it("does not pay it twice once the account has been re-hashed", async () => {
    // The other direction: an account already at BCRYPT_COST costs the same as
    // the filler by itself, so a second compare would be waste with nothing to
    // hide. This is what stops the fix being "always hash twice".
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.pass = "$2a$12$hash";
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "x" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
    expect(bcryptjs.compare).toHaveBeenCalledTimes(1);
    expect(bcryptjs.compare).not.toHaveBeenCalledWith("x", "hashed");
  });

  it("pays it for a stored value that is not a bcrypt hash at all", async () => {
    // A corrupt row, or something written by hand. `compare` rejects it in
    // microseconds, which is the same oracle as cost 8 and wider — so the cost
    // is treated as zero rather than as unknown.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.pass = "esto-no-es-un-hash";
    findOne.mockResolvedValue(user);

    const c = call({ user: "isaias", pass: "x" });
    await login(c.req, c.res);

    expect(c.status).toBe(400);
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
    await login(lockedCall.req, lockedCall.res);

    findOne.mockResolvedValue(storedUser());
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const wrong = call({ user: "isaias", pass: "x" });
    await login(wrong.req, wrong.res);

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
    await login(c.req, c.res);

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
    await login(c.req, c.res);

    expect(update).not.toHaveBeenCalled();
  });

  it("records a failure through an atomic increment, not a computed update", async () => {
    // The lookup's own `findOne` returns the account as it was before this
    // request; the second `findOne` below stands in for the re-read that
    // follows the atomic increment in `auth/credentials.ts`, returning the
    // count the database actually holds afterwards.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = 2;
    findOne.mockResolvedValueOnce(user).mockResolvedValueOnce({ dataValues: { failed_attempts: 3 } });

    const c = call({ user: "isaias", pass: "x" });
    await login(c.req, c.res);

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
    await login(c.req, c.res);

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

  it("writes the lockout to the bitácora, which nothing recorded before", async () => {
    // Without this line the log shows five LOGIN_FAILED and then one every
    // fifteen minutes, and nowhere the fact that the account has been shut the
    // whole time — the one thing somebody reading it is looking for. Its own
    // action name so a panel can separate it from ordinary failure noise.
    const { logAction } = await import("../utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = LOCKOUT_AFTER_FAILURES - 1;
    findOne
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ dataValues: { failed_attempts: LOCKOUT_AFTER_FAILURES } });

    const c = call({ user: "isaias", pass: "x" });
    await login(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCOUNT_LOCKED",
        severity: "critical",
        entity_id: 1,
        // The address matters: the whole point of reading these is telling one
        // machine grinding one account from a person mistyping their own.
        ip_address: "::1",
      }),
    );
  });

  it("does not announce a lockout that has not happened", async () => {
    // A line written on every wrong password would make the action worthless:
    // whoever reads the bitácora would be back to counting LOGIN_FAILED by hand,
    // which is the state this replaced.
    const { logAction } = await import("../utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const user = storedUser();
    user.dataValues.failed_attempts = 1;
    findOne.mockResolvedValueOnce(user).mockResolvedValueOnce({ dataValues: { failed_attempts: 2 } });

    const c = call({ user: "isaias", pass: "x" });
    await login(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "LOGIN_FAILED" }));
    expect(logAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "ACCOUNT_LOCKED" }),
    );
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
    await Promise.all([login(a.req, a.res), login(b.req, b.res)]);

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
    await login(c.req, c.res);

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
    await login(c.req, c.res);

    expect(c.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });
});
