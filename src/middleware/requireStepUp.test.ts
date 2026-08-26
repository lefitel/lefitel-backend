// `requireStepUp` — the gate on the operations a stolen session must not be
// enough for: creating and editing users, and touching roles and the
// permission matrix.
//
// This file mocks five things: `verifyOwnPassword` (the last-resort
// fallback), `tieneAlgunFactor` (whether that fallback is even reachable),
// `logAction` (the bitácora line every refusal writes), and
// `passwordConfirmLimiter` plus `passwordConfirmKey` (the shared budget the
// fallback reads and, on a wrong answer only, spends). The limiter is not in
// the original test skeleton for this task — it exists because `requireStepUp`
// shares its rate-limit bucket with `chargeConfirmBudgetOnSelfChange` in
// `usuario.routes.ts`, and the real limiter answers by writing real headers
// on a real `Response`, which the bare `res` fixture below is not. Mocking it
// here keeps this file a unit test of `requireStepUp`'s own decisions; the
// shared bucket's arithmetic is `loginLimiters.test.ts`'s job, and that file
// gained its own cases for the one thing only this gate needed from it — see
// "confirmCostsNothing" there.

import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyOwnPassword = vi.fn();
const tieneAlgunFactor = vi.fn();
const logAction = vi.fn();
const passwordConfirmLimiter = vi.fn() as ReturnType<typeof vi.fn> & { getKey: ReturnType<typeof vi.fn> };
passwordConfirmLimiter.getKey = vi.fn();
const passwordConfirmKey = vi.fn();
vi.mock("../auth/credentials.js", () => ({ verifyOwnPassword }));
vi.mock("../auth/factorInventory.js", () => ({ tieneAlgunFactor }));
vi.mock("../utils/logAction.js", () => ({ logAction }));
// `importOriginal` pulls the real `PASSWORD_CONFIRM_MESSAGE` through rather
// than retyping the sentence a third time (`loginLimiters.ts` names it once,
// `requireStepUp.ts` imports it) — a third hand-typed copy is exactly the
// drift that constant exists to rule out, even one sitting only in a test.
vi.mock("./loginLimiters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loginLimiters.js")>();
  return { ...actual, passwordConfirmLimiter, passwordConfirmKey };
});

const {
  requireStepUp,
  CODIGO_STEP_UP,
  MOTIVO_ESTADO_INCOMPLETO,
  MOTIVO_SIN_FACTOR_RECIENTE,
  MOTIVO_CONTRASENA_INCORRECTA,
} = await import("./requireStepUp.js");
const { STEP_UP_WINDOW_MINUTES } = await import("../config/security.js");

const haceMinutos = (m: number) => new Date(Date.now() - m * 60_000);

function contexto(user: Record<string, unknown> | undefined, body: unknown = {}) {
  const req = { user, body, ip: "::1", originalUrl: "/api/rol/1" } as never;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: {} } as never;
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  verifyOwnPassword.mockReset();
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  logAction.mockReset();
  passwordConfirmKey.mockReset().mockReturnValue("pc:1");
  // The default: nothing spent yet, so the read-only pre-check lets the
  // fallback reach `verifyOwnPassword` in every test that does not say
  // otherwise.
  passwordConfirmLimiter.getKey.mockReset().mockResolvedValue(undefined);
  // Only reached on a confirmed-wrong password (see requireStepUp.ts's own
  // comment on why): under budget, so it charges and calls on. Mirrors what
  // the real limiter does when the account has room left.
  passwordConfirmLimiter.mockReset().mockImplementation((_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
    next();
  });
});

describe("requireStepUp", () => {
  it("lets through a factor proved inside the window", async () => {
    // tieneAlgunFactor is forced true so this can only pass by the window
    // rule — with the default false, branch 3's skip (no factor, no
    // password) produces the identical observable outcome (next() called,
    // nothing charged) and this test would stay green with the window
    // check deleted entirely, which is what a fix-round review caught.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES - 1),
    });
    await requireStepUp()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("refuses a factor proved one minute outside the window", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES + 1),
    });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
    );
  });

  it("refuses a session that came in on a remembered device", async () => {
    // A remembered login leaves `mfa_satisfied_at` NULL on purpose. If it did
    // not, stealing that cookie plus the password would be enough to edit the
    // permission matrix without touching a single factor — which is the whole
    // reason the column and the remembered device are separate things.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("answers with a code the frontend can act on, not just a message", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: CODIGO_STEP_UP }),
    );
  });

  it("accepts the current password while the account has no factor at all", async () => {
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("stops accepting the password the moment a factor exists", async () => {
    // The narrow window this fallback exists for closes by itself. Somebody who
    // has a factor and only knows the password must not reach these routes —
    // that is precisely the attacker the second factor is for.
    tieneAlgunFactor.mockResolvedValue(true);
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(verifyOwnPassword).not.toHaveBeenCalled();
  });

  it("refuses an onboarding session outright, password or not", async () => {
    // Somebody still setting up must not create users or touch roles. If the
    // password alone opened these during the grace period, the second factor
    // would be optional for exactly the operations it exists to protect.
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "onboarding", mfa_satisfied_at: haceMinutos(1) },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
    );
  });

  it("writes a bitácora line when it refuses", async () => {
    // An attacker probing these routes is invisible otherwise.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
    );
  });

  it("refuses when there is no user at all", async () => {
    // Mounted behind `authenticate`, so this cannot happen — unless somebody
    // mounts it in front of it one day. Fail closed.
    const { req, res, next } = contexto(undefined);
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("answers 500 instead of hanging when tieneAlgunFactor itself fails", async () => {
    // Express 4 does not catch a rejected promise from an `async`
    // middleware — a query that throws here, with nothing catching it,
    // would leave the request hanging until the client gave up rather than
    // answering anything at all. `authenticate.ts` wraps its whole body in
    // one try/catch for exactly this reason; this gate does the same.
    tieneAlgunFactor.mockRejectedValue(new Error("la tabla de factores no respondió"));
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("names the inner handler stepUpGate, not an anonymous function", () => {
    // A later task walks the mounted Express stack the way
    // `routeGuards.test.ts` already does for `requirePermissionGate`, and it
    // can only tell a gated route from an open one by this name.
    expect(requireStepUp().name).toBe("stepUpGate");
  });

  describe("the password fallback's own budget", () => {
    // `requireStepUp` shares `passwordConfirmLimiter` with
    // `chargeConfirmBudgetOnSelfChange` (see `usuario.routes.ts`) rather than
    // counting its own guesses separately — a second bucket keyed the same way
    // would hand out ten attempts a quarter of an hour to anybody willing to
    // alternate the two doors onto the same secret.
    //
    // This gate only ever *charges* (calls `passwordConfirmLimiter` itself)
    // on a confirmed-wrong password — see requireStepUp.ts's own comment on
    // why a fix round moved it away from charging unconditionally and
    // refunding a right answer afterwards. Checking whether the budget is
    // already spent, before that, reads the count through `getKey` instead —
    // which is why the tests below mock `getKey` for the "already spent" and
    // "read fails" cases, and the callable `passwordConfirmLimiter` itself
    // only for the "charging a wrong answer fails" case.

    it("reads the budget before the password is looked at, and refuses for free once it is spent", async () => {
      const { PASSWORD_CONFIRM_LIMIT } = await import("../config/security.js");
      passwordConfirmLimiter.getKey.mockResolvedValue({ totalHits: PASSWORD_CONFIRM_LIMIT, resetTime: new Date() });
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      // Read, not charged: nothing here was ever wrong, so there is nothing
      // for the real limiter to increment.
      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      // The brief's own rule — every refusal writes one — includes this one.
      // Not through `denegar` (that would answer a second response on top of
      // the 429 above), but written all the same.
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
      );
    });

    it("fails closed when reading the budget itself errors, instead of comparing the password anyway", async () => {
      // A store that cannot even answer "how many hits" is not a store this
      // gate can trust to have been enforcing anything.
      const fallo = new Error("el almacén del limitador no respondió");
      passwordConfirmLimiter.getKey.mockRejectedValue(fallo);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalledWith(fallo);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("fails closed when charging a confirmed-wrong password errors, instead of answering as a plain wrong password", async () => {
      // `express-rate-limit` routes a store failure to the third argument as
      // `next(error)`, not to a plain "denied" — `MemoryStore` never does
      // this today, but the Redis store this file already anticipates does.
      // A callback that ignored that argument would let this gate answer a
      // store failure as "your password was wrong", with the real error
      // vanishing.
      verifyOwnPassword.mockResolvedValue({ ok: false });
      const fallo = new Error("el almacén del limitador no respondió");
      passwordConfirmLimiter.mockImplementation((_req: unknown, _res: unknown, cb: (err?: unknown) => void) => {
        cb(fallo);
      });
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "no-es-la-mia" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalledWith(fallo);
      // Nothing of this gate's own — the error handler downstream answers,
      // not this middleware racing it with a response of its own.
      expect(res.status).not.toHaveBeenCalled();
    });

    it("never touches the budget when a factor already exists", async () => {
      // Constraint: the password is only accepted while tieneAlgunFactor is
      // false, checked before the password is even looked at. The budget is
      // part of "looking at the password", so it must not be read or spent
      // either.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
      await requireStepUp()(req, res, next);

      expect(passwordConfirmLimiter.getKey).not.toHaveBeenCalled();
      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });

    it("never touches the budget for an onboarding session", async () => {
      const { req, res, next } = contexto(
        { id: 1, estado: "onboarding", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(passwordConfirmLimiter.getKey).not.toHaveBeenCalled();
      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });

    it("never touches the budget when the window already satisfies the gate", async () => {
      // Same reason as "lets through a factor proved inside the window":
      // forcing a factor to exist is what makes this test depend on the
      // window rule instead of on branch 3's skip, which also never
      // touches the budget.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto({
        id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES - 1),
      });
      await requireStepUp()(req, res, next);

      // Both assertions matter: the budget-untouched half is also true of
      // a refusal (tieneAlgunFactor's own branch never touches it either),
      // so without next() actually having been called this test cannot
      // tell "let through by the window" apart from "refused by the factor
      // check" — a fix-round review found exactly that gap.
      expect(next).toHaveBeenCalled();
      expect(passwordConfirmLimiter.getKey).not.toHaveBeenCalled();
      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });

    it("never charges the budget for a password that turns out to be right", async () => {
      // The other half of the fix: charging unconditionally and refunding a
      // right answer afterwards is what let this gate's own not-yet-refunded
      // charge inflate the count `chargeConfirmBudgetOnSelfChange` reads for
      // its own, separate charge on the same key — see requireStepUp.ts's
      // docstring. Never charging on a right answer removes that charge
      // entirely, rather than making it and giving it back.
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });

    /**
     * The gate that nothing could satisfy, found by a separate audit of this
     * branch: `web/src` never sends `stepup_password` — that frontend is a
     * later plan's job — so an earlier version of this file that refused
     * outright whenever `tieneAlgunFactor` said no was refusing *every*
     * gated write on every account, unconditionally, because nothing
     * anywhere could ever answer its own fallback. An account with no
     * factor has nothing beyond its session to prove, which is exactly the
     * state the whole ERP was already in — so letting the write through
     * costs nothing that was not already true, and it costs it loudly, via
     * a bitácora line, rather than silently.
     */
    describe("an account with no factor and no password to prove it", () => {
      it("lets the write through, rather than refusing a gate nothing can satisfy", async () => {
        const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});
        await requireStepUp()(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        // Nothing was read or spent — there was nothing to check a budget
        // against.
        expect(passwordConfirmLimiter.getKey).not.toHaveBeenCalled();
        expect(passwordConfirmLimiter).not.toHaveBeenCalled();
        expect(verifyOwnPassword).not.toHaveBeenCalled();
      });

      it("treats an empty string the same as no password at all", async () => {
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "" },
        );
        await requireStepUp()(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it("writes a distinct, non-critical bitácora line when it skips", async () => {
        // Not STEP_UP_DENIED (that name means a refusal) and not `critical`
        // (that severity means one) — this account was not refused
        // anything, so counting it alongside real refusals would make the
        // one action name meant for attackers unreadable.
        const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});
        await requireStepUp()(req, res, next);

        expect(logAction).toHaveBeenCalledWith(
          expect.objectContaining({ action: "STEP_UP_SKIPPED", severity: "warning" }),
        );
        expect(logAction).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "STEP_UP_DENIED" }),
        );
      });

      it("still verifies, and still charges on a wrong guess, when a password is sent anyway", async () => {
        // The shape the later frontend plan will use, and the only shape
        // this ever refuses for a factor-less account.
        verifyOwnPassword.mockResolvedValue({ ok: false });
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "no-es-la-mia" },
        );
        await requireStepUp()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(passwordConfirmLimiter).toHaveBeenCalled();
        // The discriminator a client acts on to know *which* remedy applies
        // — a client cannot tell "type the password again" apart from "go
        // finish onboarding" by `code` alone, since both answer the same
        // `CODIGO_STEP_UP`.
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ motivo: MOTIVO_CONTRASENA_INCORRECTA }),
        );
      });

      it("still lets a correct password through, charging nothing", async () => {
        verifyOwnPassword.mockResolvedValue({ ok: true });
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "la-de-verdad" },
        );
        await requireStepUp()(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(passwordConfirmLimiter).not.toHaveBeenCalled();
      });

      it("closes on its own the moment the account has a factor: the same no-password request is then refused", async () => {
        // The assertion that proves the skip is temporary by construction,
        // not by intention: nothing here is a flag that gets cleared or a
        // cleanup task that has to run. `tieneAlgunFactor` answering `true`
        // is the one thing this whole branch depends on never being reached
        // for an account that has registered anything.
        tieneAlgunFactor.mockResolvedValue(true);
        const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});
        await requireStepUp()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(logAction).toHaveBeenCalledWith(
          expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
        );
      });
    });
  });
});
