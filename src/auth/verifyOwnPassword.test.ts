// `verifyOwnPassword` — the second door onto the credential check, and the four
// things it exists not to do.
//
// The screen that renames your own account asks for your password "to confirm",
// and it used to check it **by calling the login**. That opened a session (so
// the rotation on the way in revoked the one the browser was using), wrote
// "Inició sesión" to the bitácora for a login nobody performed, spent a failed
// attempt on the account (so mistyping while renaming yourself could lock you
// out of the ERP), and answered in a shape the client only read correctly by
// accident.
//
// So the assertions here are mostly about absence, and absence is the assertion
// shape this project has watched pass against broken code — "no session was
// created" is true of a handler that does nothing at all. Every test below
// therefore pins the answer *and* the absence in the same case, and the three
// that matter most are written as **comparisons against the login**: the same
// row and the same password through both doors, where only one of them charges
// the account and only one of them refuses a locked one. A copy of the
// bookkeeping reintroduced on this side fails those, and so does deleting the
// login's half instead of parameterising it.
//
// **These used to go in through `POST /api/auth/confirm-password`**, which was
// this function's other caller and is retired: asking for the password *before*
// an operation was the wrong shape, since the credential that authorises a write
// belongs in the request that performs it (see `auth.routes.ts`). What the
// endpoint's own tests asserted — a 200 with a boolean, the mapping from
// `reason` to a status — went with it. What is left is this function, whose
// caller is `updateUserName`, and every rule below is one the rename inherits
// without having had to remember it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const findOne = vi.fn();
const findByPk = vi.fn();
const update = vi.fn();
// The atomic counter behind the lockout. Exposed as its own spy because "the
// account was not charged" is exactly what this door promises, and this is the
// call that would charge it.
const increment = vi.fn().mockResolvedValue(undefined);
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findOne: (...args: unknown[]) => findOne(...args),
    findByPk: (...args: unknown[]) => findByPk(...args),
    update: (...args: unknown[]) => update(...args),
    increment: (...args: unknown[]) => increment(...args),
  },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));

// Both doors, from the one module that holds them. Straight to the functions and
// not through a controller: `verifyOwnPassword` has one caller now, and what
// that caller does with the answer — which status code, which sentence — is
// `usuario.controller.test.ts`'s business. Here it is the answer itself.
const { verifyOwnPassword, verifyCredentials } = await import("./credentials.js");
const { LOCKOUT_AFTER_FAILURES, CREDENCIALES_INVALIDAS } = await import("../config/security.js");

const YO = 7;

/** The account the caller's cookie belongs to. Stored at the historical cost 8. */
function storedUser() {
  return {
    dataValues: {
      id: YO,
      id_rol: 3,
      user: "isaias",
      pass: "$2a$08$hash",
      name: "Isaias",
      lastname: "Salas",
      image: null,
      failed_attempts: 0,
      locked_until: null as Date | null,
    },
  };
}

/**
 * The row of an account that is resting right now.
 *
 * `locked_until` in the future and the failure count at the threshold, which is
 * the state the login's own bookkeeping produces — not an invented combination.
 */
function lockedUser() {
  const row = storedUser();
  row.dataValues.locked_until = new Date(Date.now() + 60_000);
  row.dataValues.failed_attempts = LOCKOUT_AFTER_FAILURES;
  return row;
}

/** The caller's own id and nothing else. There is no username in this request. */
const ask = (pass: unknown, id = YO) => verifyOwnPassword({ id, pass, ip: "::1" });

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue(storedUser());
  findOne.mockResolvedValue(storedUser());
});

describe("what the answer is", () => {
  it("says yes, and really compared the password against the stored hash", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const res = await ask("la-mia");

    expect(res.ok).toBe(true);
    // Not merely truthy: it reached this answer by comparing, not by never
    // looking.
    expect(bcryptjs.compare).toHaveBeenCalledWith("la-mia", "$2a$08$hash");
  });

  it("says no with a reason, and the reason is the password", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const res = await ask("no-es-la-mia");

    expect(res.ok).toBe(false);
    // The reason and not just the falsehood: `no-account` is also a `false`
    // here, and the caller maps the two to different status codes. A test that
    // only checked `ok` would pass for a door that confused them.
    expect(res.ok === false && res.reason).toBe("wrong-password");
  });

  it("refuses a password that is missing, empty, or not a string at all", async () => {
    // These arrive from a form, so a missing field is the likeliest of them.
    // None of them may be read as a confirmation, and none may reach the
    // database: an object here is what Sequelize would take as a condition.
    for (const pass of [undefined, "", { ne: null }, ["x"], 7, null]) {
      vi.clearAllMocks();
      findByPk.mockResolvedValue(storedUser());
      const res = await ask(pass);

      expect(res.ok, JSON.stringify(pass)).toBe(false);
      expect(res.ok === false && res.reason, JSON.stringify(pass)).toBe("wrong-password");
      expect(findByPk, JSON.stringify(pass)).not.toHaveBeenCalled();
    }
  });

  it("says the account is gone, not that the password is wrong, when it was archived a moment ago", async () => {
    // The race between `authenticate` and this call. Reporting `wrong-password`
    // would tell somebody their password is wrong when what happened is that
    // their session ended, and they would spend the afternoon retyping it. The
    // caller answers 404 to this and 401 to the one above.
    findByPk.mockResolvedValue(null);

    const res = await ask("la-mia");

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("no-account");
  });

  it("asks about the id it was handed, and looks nothing up by name", async () => {
    // The whole reason this cannot be used to probe other accounts. The id comes
    // from `req.user`, and there is no username anywhere in the request for the
    // login's own case-folded lookup to be pointed at.
    await ask("la-mia");

    expect(findByPk).toHaveBeenCalledTimes(1);
    expect(findByPk).toHaveBeenCalledWith(YO);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("hands back nothing about the account, not even on the way to saying yes", async () => {
    // A yes/no answer that carried a profile would be a second way of reading
    // account data, and the row it holds carries the password hash.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const res = await ask("la-mia");

    expect(Object.keys(res)).toEqual(["ok"]);
    for (const filtrado of ["$2a$08$hash", "isaias", "Salas", "failed_attempts"]) {
      expect(JSON.stringify(res), filtrado).not.toContain(filtrado);
    }
  });
});

describe("what it must not do, said against the login that used to do it", () => {
  it("does not charge the account for a wrong password, where the login does", async () => {
    /**
     * Effect three of the four, and the one that hurt: a typo here counted as a
     * failed login attempt, so getting your own password wrong
     * LOCKOUT_AFTER_FAILURES times while renaming yourself shut you out of the
     * ERP — behind a message that said "Contraseña incorrecta" and nothing
     * about a lockout.
     *
     * Written as a comparison rather than as `expect(increment).not.toHaveBeen
     * Called()` on its own, because that assertion also passes for a door that
     * never checks anything. Both doors get the same wrong password in the same
     * test: the login charges, this does not, and a copy of the bookkeeping
     * added here fails the first expectation while the second keeps the test
     * honest.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const porLaPuertaDelLogin = await verifyCredentials({
      user: "isaias",
      pass: "no-es-la-mia",
      ip: "::1",
    });
    expect(porLaPuertaDelLogin.ok).toBe(false);
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: YO } });

    increment.mockClear();
    update.mockClear();

    const res = await ask("no-es-la-mia");

    expect(res.ok).toBe(false);
    expect(increment).not.toHaveBeenCalled();
    // Nor the other half of the bookkeeping: no `locked_until`, no clearing.
    expect(update).not.toHaveBeenCalled();
  });

  it("cannot lock the account however many times the password is wrong", async () => {
    // The property behind the test above, stated the way somebody would
    // actually hit it: enough wrong attempts in a row. Two more than the
    // threshold, so a lockout would certainly have happened by the last one.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    for (let i = 0; i < LOCKOUT_AFTER_FAILURES + 2; i++) {
      const res = await ask(`intento-${i}`);
      expect(res.ok, `intento ${i}`).toBe(false);
    }

    expect(increment).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("writes no line saying anybody logged in", async () => {
    // Effect two. The bitácora gained a "Inició sesión" for a login that never
    // happened, in the one place somebody looks to find out who got in and
    // when. On a correct password this door writes nothing at all.
    const { logAction } = await import("../utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const res = await ask("la-mia");

    // It said yes — so the absence below is the absence of a check that ran,
    // not of a function that did nothing.
    expect(res.ok).toBe(true);
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("what it keeps from the login, and the one thing it deliberately does not", () => {
  it("pays the filler hash on a wrong password against a cheaply stored one", async () => {
    // Inherited rather than decided here, and that is the point of sharing
    // `checkAgainstRow`: the levelled timing is not a thing this door had to
    // remember. Deleting the extra compare in `credentials.ts` fails this as
    // well as its twin in `credentials.test.ts` — two doors, one hole.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    await ask("no-es-la-mia");

    expect(bcryptjs.compare).toHaveBeenCalledWith("no-es-la-mia", "$2a$08$hash");
    // "hashed" is what the mocked `bcryptjs.hash` returns, so it is what
    // `fillerHash()` resolves to.
    expect(bcryptjs.compare).toHaveBeenCalledWith("no-es-la-mia", "hashed");
  });

  it("answers a locked account on the merits of its password, where the login refuses one outright", async () => {
    /**
     * The one policy the two doors do **not** share, and the defect that made it
     * a policy instead of a shared line of code.
     *
     * The lockout counts *login* attempts, and `authenticate` does not read it,
     * so somebody whose account was locked by another machine grinding their
     * username keeps the session they already had and keeps working in it. This
     * door used to borrow the login's refusal anyway, which meant the screen
     * that renames your own account told them their **correct** password was
     * wrong — five times, each one spending a token of a budget shared with the
     * password change, until the sixth answer was a 429 that closed the only
     * self-service way out of the lockout they were in.
     *
     * Written as a comparison, and that is the whole design of this test. The
     * cheap way to make the rename work would have been to delete the
     * locked-account refusal from `checkAgainstRow` altogether — which would
     * satisfy the second half of this test and fail the first, because the login
     * would then let a resting account in. Both halves see the same row and the
     * same correct password; only the named policy separates them.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    // The login: refused before anything real is compared, and told the uniform
    // sentence so a lockout is not an oracle naming which accounts are shut.
    findOne.mockResolvedValue(lockedUser());
    const porLaPuertaDelLogin = await verifyCredentials({
      user: "isaias",
      pass: "la-mia",
      ip: "::1",
    });
    expect(porLaPuertaDelLogin.ok).toBe(false);
    expect(porLaPuertaDelLogin.message).toBe(CREDENCIALES_INVALIDAS);
    expect(bcryptjs.compare).not.toHaveBeenCalledWith("la-mia", "$2a$08$hash");
    expect(bcryptjs.compare).toHaveBeenCalledWith("la-mia", "hashed");

    vi.mocked(bcryptjs.compare).mockClear();

    // This door: the same row, the same password, and the real hash is actually
    // compared this time.
    findByPk.mockResolvedValue(lockedUser());
    const res = await ask("la-mia");

    expect(res.ok).toBe(true);
    expect(bcryptjs.compare).toHaveBeenCalledWith("la-mia", "$2a$08$hash");
  });

  it("lifts the lockout it just ignored, rather than leaving the account resting", async () => {
    // The consequence of the policy above, pinned so it is a decision and not a
    // surprise: the shared success path clears both columns, so confirming the
    // right password while locked comes out unlocked. It costs the correct
    // password, which is the same evidence `updateUserPass` lifts a lockout for
    // on purpose — see `LockoutPolicy`.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    findByPk.mockResolvedValue(lockedUser());

    const res = await ask("la-mia");

    expect(res.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      { failed_attempts: 0, locked_until: null },
      { where: { id: YO } },
    );
  });

  it("clears a failure count the caller had accumulated, on a correct password", async () => {
    // The other half of sharing one implementation: proving you know your
    // password is the same evidence a successful login gives, so it wipes the
    // slate the same way. Not a locked account — that one is above — just one
    // with a couple of failures behind it.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const conFallos = storedUser();
    conFallos.dataValues.failed_attempts = 2;
    findByPk.mockResolvedValue(conFallos);

    const res = await ask("la-mia");

    expect(res.ok).toBe(true);
    expect(update).toHaveBeenCalledWith({ failed_attempts: 0, locked_until: null }, { where: { id: YO } });
  });

  it("records the failed attempt in the bitácora, under its own action", async () => {
    /**
     * The third way out of the counter question, and the reason it is not
     * simply "no counter": a run of these on one account is somebody holding a
     * session and guessing at the password behind it, which is the event worth
     * finding. Its own action name rather than LOGIN_FAILED, because writing
     * LOGIN_FAILED here would be forging the same false record the old
     * implementation left — a login attempt nobody made — and it would drown the
     * line the login panel reads.
     */
    const { logAction } = await import("../utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    await ask("no-es-la-mia");

    expect(logAction).toHaveBeenCalledTimes(1);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PASSWORD_CONFIRM_FAILED",
        id_usuario: YO,
        severity: "warning",
        // The address, for the same reason as every other line in this family:
        // one machine grinding one account reads differently from one person
        // mistyping their own password.
        ip_address: "::1",
      }),
    );
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LOGIN_FAILED" }));
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LOGIN" }));
  });
});
