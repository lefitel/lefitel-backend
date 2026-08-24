// `POST /api/auth/confirm-password` — the second door onto the credential
// check, and the four things it exists not to do.
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
// therefore pins the answer *and* the absence in the same case, and the two
// that matter most are written as **comparisons against the login**: the same
// wrong password, through both doors, and only one of them charges the account.
// A copy of the bookkeeping reintroduced on this side fails those.
//
// Goes through the real handler rather than calling `verifyOwnPassword`,
// because half of what is being asserted is the mapping: a refusal the function
// reports correctly and the endpoint answers `correcta: true` to is not a
// refusal. `app.auth.test.ts` covers the same endpoint through the real Express
// stack — the mount, `authenticate` in front of it, and the rate limit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findOne = vi.fn();
const findByPk = vi.fn();
const update = vi.fn();
// The atomic counter behind the lockout. Exposed as its own spy because "the
// account was not charged" is exactly what this endpoint promises, and this is
// the call that would charge it.
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
vi.mock("../permissions/store.js", () => ({ permissionsFor: async () => ({}) }));
// The same two mocks `credentials.test.ts` explains at length: `issueSession`
// and the session store reach `sesion.model.ts`, which calls
// `UsuarioModel.hasMany` while being imported — on the stub above, which has no
// such method, so the suite would fail to load before running an assertion.
// Mocking `issueSession` here has a second meaning, though: this endpoint must
// never open a session, and the spy below is what says so.
const issueSession = vi.fn();
vi.mock("./issueSession.js", () => ({ issueSession: (...args: unknown[]) => issueSession(...args) }));
vi.mock("./sessionStore.js", () => ({
  listSessionsOf: vi.fn(),
  revokeAllSessionsOf: vi.fn(),
  revokeSessionOf: vi.fn(),
}));

const { confirmPassword, login } = await import("../controllers/auth.controller.js");
const { LOCKOUT_AFTER_FAILURES } = await import("../config/security.js");

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
 * A request as `authenticate` leaves it: a `req.user` with all four fields.
 *
 * The id is only ever read from here. Nothing in these tests puts a username or
 * an id in the body, because the endpoint takes neither — which is the reason
 * there is nothing to enumerate through it.
 */
function call(body: unknown, user: Request["user"] | null = { id: YO, id_rol: 3, id_sesion: "s", expires_at: new Date() }) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return {
    req: { body, ip: "::1", headers: {}, user: user ?? undefined } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get answer() {
      return res.body as { correcta?: unknown; message?: string } | undefined;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue(storedUser());
  findOne.mockResolvedValue(storedUser());
});

describe("what the answer is", () => {
  it("says the password is right, with an explicit true and a 200", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const c = call({ pass: "la-mia" });
    await confirmPassword(c.req, c.res);

    expect(c.status).toBe(200);
    // `toBe(true)`, not truthy and not "has the field": the client is required
    // to compare against exactly `true`, so an endpoint answering a string, a
    // 1, or an object here would break it while satisfying a looser assertion.
    expect(c.answer?.correcta).toBe(true);
    // And it really compared the password against the stored hash, rather than
    // reaching this line by never looking.
    expect(bcryptjs.compare).toHaveBeenCalledWith("la-mia", "$2a$08$hash");
  });

  it("says the password is wrong, and says it in the body rather than the status", async () => {
    /**
     * The test the "make it always say yes" break has to fall over, and the
     * reason it asserts the field and not the status: this endpoint answers 200
     * either way on purpose. A status-only assertion here would pass for both
     * answers, which is the trap this plan has already been caught by once — a
     * `toBe(401)` that stayed green with the broken branch restored, because
     * something else on the path answered 401 too.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const c = call({ pass: "no-es-la-mia" });
    await confirmPassword(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.answer?.correcta).toBe(false);
    // A sentence to show, and it is not the login's: no username was sent, so
    // naming one would send somebody hunting for a mistake they could not have
    // made.
    expect(c.answer?.message).toBe("Esa no es su contraseña actual.");
    expect(c.answer?.message).not.toContain("Usuario");
  });

  it("refuses a password that is missing, empty, or not a string at all", async () => {
    // These arrive from a form, so a missing field is the likeliest of them.
    // None of them may be read as a confirmation, and none may reach the
    // database: an object here is what Sequelize would take as a condition.
    for (const pass of [undefined, "", { ne: null }, ["x"], 7, null]) {
      vi.clearAllMocks();
      findByPk.mockResolvedValue(storedUser());
      const c = call({ pass });
      await confirmPassword(c.req, c.res);

      expect(c.answer?.correcta, JSON.stringify(pass)).toBe(false);
      expect(findByPk, JSON.stringify(pass)).not.toHaveBeenCalled();
    }
  });

  it("answers 401, not a wrong password, when the account was archived a moment ago", async () => {
    // The race between `authenticate` and this handler. Answering `correcta:
    // false` would tell somebody their password is wrong when what happened is
    // that their session ended, and they would spend the afternoon retyping it.
    findByPk.mockResolvedValue(null);

    const c = call({ pass: "la-mia" });
    await confirmPassword(c.req, c.res);

    expect(c.status).toBe(401);
    // Pinned on the reason and not just the number: 401 is also what the
    // no-caller branch answers, and the two must not be confused for one
    // another by a test.
    expect(c.answer?.message).toBe("Su cuenta ya no está activa.");
    expect(c.answer).not.toHaveProperty("correcta");
  });

  it("asks about the caller's own id, never about anything in the body", async () => {
    // The whole reason this cannot be used to probe other accounts. A body
    // carrying somebody else's id or username has to change nothing about
    // which row is read.
    const c = call({ pass: "la-mia", id: 999, user: "otro" });
    await confirmPassword(c.req, c.res);

    expect(findByPk).toHaveBeenCalledTimes(1);
    expect(findByPk).toHaveBeenCalledWith(YO);
    // And the username lookup the login uses is never reached, because there is
    // no name here to look up.
    expect(findOne).not.toHaveBeenCalled();
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
     * Called()` on its own, because that assertion also passes for a handler
     * that never checks anything. Both doors get the same wrong password in the
     * same test: the login charges, this does not, and a copy of the
     * bookkeeping added here fails the first expectation while the second keeps
     * the test honest.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const porLaPuertaDelLogin = call({ user: "isaias", pass: "no-es-la-mia" });
    await login(porLaPuertaDelLogin.req, porLaPuertaDelLogin.res);
    expect(increment).toHaveBeenCalledWith("failed_attempts", { where: { id: YO } });

    increment.mockClear();
    update.mockClear();

    const confirmando = call({ pass: "no-es-la-mia" });
    await confirmPassword(confirmando.req, confirmando.res);

    expect(confirmando.answer?.correcta).toBe(false);
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
      const c = call({ pass: `intento-${i}` });
      await confirmPassword(c.req, c.res);
      expect(c.answer?.correcta, `intento ${i}`).toBe(false);
    }

    expect(increment).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("opens no session and writes no line saying anybody logged in", async () => {
    // Effects one and two. The session rotation revoked the cookie the browser
    // was already using, so editing your own name logged you out of the tab you
    // were doing it in; and the bitácora gained a "Inició sesión" for a login
    // that never happened, in the one place somebody looks to find out who got
    // in and when.
    const { logAction } = await import("../utils/logAction.js");
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const c = call({ pass: "la-mia" });
    await confirmPassword(c.req, c.res);

    // It said yes — so the absences below are the absences of a check that ran,
    // not of a handler that did nothing.
    expect(c.answer?.correcta).toBe(true);
    expect(issueSession).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("hands back nothing about the account, not even on the way to saying yes", async () => {
    // A confirm endpoint that answers with a profile is a second way of reading
    // account data, and the row it holds carries the password hash. The whole
    // answer is one boolean.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const c = call({ pass: "la-mia" });
    await confirmPassword(c.req, c.res);

    expect(Object.keys(c.answer ?? {})).toEqual(["correcta"]);
    for (const filtrado of ["$2a$08$hash", "isaias", "Salas", "failed_attempts"]) {
      expect(JSON.stringify(c.answer), filtrado).not.toContain(filtrado);
    }
  });
});

describe("what it keeps from the login, because it is one implementation", () => {
  it("pays the filler hash on a wrong password against a cheaply stored one", async () => {
    // Inherited rather than decided here, and that is the point of sharing
    // `checkAgainstRow`: the levelled timing is not a thing this endpoint had
    // to remember. Deleting the extra compare in `credentials.ts` fails this as
    // well as its twin in `credentials.test.ts` — two doors, one hole.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);

    const c = call({ pass: "no-es-la-mia" });
    await confirmPassword(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalledWith("no-es-la-mia", "$2a$08$hash");
    // "hashed" is what the mocked `bcryptjs.hash` returns, so it is what
    // `fillerHash()` resolves to.
    expect(bcryptjs.compare).toHaveBeenCalledWith("no-es-la-mia", "hashed");
  });

  it("refuses while the account is locked, instead of lifting the lockout", async () => {
    /**
     * The decision this pins is the uncomfortable one. A locked account gets
     * `correcta: false` here even for the *right* password, which is the wrong
     * sentence for that caller — and it stays that way because the success path
     * clears `failed_attempts` and `locked_until`. Letting a locked account
     * through this door would make it a way of lifting a lockout with a
     * password the lockout exists to stop being guessed.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const bloqueada = storedUser();
    bloqueada.dataValues.locked_until = new Date(Date.now() + 60_000);
    bloqueada.dataValues.failed_attempts = LOCKOUT_AFTER_FAILURES;
    findByPk.mockResolvedValue(bloqueada);

    const c = call({ pass: "la-mia" });
    await confirmPassword(c.req, c.res);

    expect(c.answer?.correcta).toBe(false);
    // And the row is untouched: the lockout is not shortened, not cleared, not
    // extended.
    expect(update).not.toHaveBeenCalled();
    // The real hash was never compared — the refusal came before it — and the
    // filler was, so the two answers still take the same time.
    expect(bcryptjs.compare).not.toHaveBeenCalledWith("la-mia", "$2a$08$hash");
    expect(bcryptjs.compare).toHaveBeenCalledWith("la-mia", "hashed");
  });

  it("clears a failure count the caller had accumulated, on a correct password", async () => {
    // The other half of sharing one implementation: proving you know your
    // password is the same evidence a successful login gives, so it wipes the
    // slate the same way. Not a locked account — that one returns above — just
    // one with a couple of failures behind it.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    const conFallos = storedUser();
    conFallos.dataValues.failed_attempts = 2;
    findByPk.mockResolvedValue(conFallos);

    const c = call({ pass: "la-mia" });
    await confirmPassword(c.req, c.res);

    expect(c.answer?.correcta).toBe(true);
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

    const c = call({ pass: "no-es-la-mia" });
    await confirmPassword(c.req, c.res);

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

describe("without a caller", () => {
  it("answers 401 and never looks at a password", async () => {
    // Unreachable through the mount — `authenticate` answers first — and
    // written anyway, because this handler is exported and the guard that makes
    // it safe lives in another file. `app.auth.test.ts` asserts the mount
    // itself.
    const c = call({ pass: "la-mia" }, null);
    await confirmPassword(c.req, c.res);

    expect(c.status).toBe(401);
    expect(findByPk).not.toHaveBeenCalled();
  });
});
