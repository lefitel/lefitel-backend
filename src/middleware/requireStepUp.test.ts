// `requireStepUp` — the gate on the operations a stolen session must not be
// enough for: creating and editing users, and touching roles and the
// permission matrix.
//
// This file mocks four things: `verifyOwnPassword` (the last-resort
// fallback), `tieneAlgunFactor` (whether that fallback is even reachable),
// `logAction` (the bitácora line every refusal writes), and
// `passwordConfirmLimiter` (the shared budget the fallback spends). The
// fourth is not in the original test skeleton for this task — it exists
// because `requireStepUp` shares its rate-limit bucket with
// `chargeConfirmBudgetOnSelfChange` in `usuario.routes.ts`, and the real
// limiter answers by writing real headers on a real `Response`, which the
// bare `res` fixture below is not. Mocking it here keeps this file a unit
// test of `requireStepUp`'s own decisions; the shared bucket's arithmetic is
// `loginLimiters.test.ts`'s job, and that file gained its own cases for the
// one thing only this gate needed from it — see "confirmCostsNothing" there.

import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyOwnPassword = vi.fn();
const tieneAlgunFactor = vi.fn();
const logAction = vi.fn();
const passwordConfirmLimiter = vi.fn();
vi.mock("../auth/credentials.js", () => ({ verifyOwnPassword }));
vi.mock("../auth/factorInventory.js", () => ({ tieneAlgunFactor }));
vi.mock("../utils/logAction.js", () => ({ logAction }));
vi.mock("./loginLimiters.js", () => ({ passwordConfirmLimiter }));

const { requireStepUp, CODIGO_STEP_UP } = await import("./requireStepUp.js");
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
  // The default: under budget, so the fallback reaches `verifyOwnPassword` in
  // every test that does not say otherwise. Mirrors what the real limiter
  // does when the account has room left — calls on.
  passwordConfirmLimiter.mockReset().mockImplementation((_req: unknown, _res: unknown, next: () => void) => {
    next();
  });
});

describe("requireStepUp", () => {
  it("lets through a factor proved inside the window", async () => {
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

    it("checks the budget before the password is looked at, and refuses once it is spent", async () => {
      // The limiter answers its own 429 and never calls on — exactly what the
      // real one does when an account has none left.
      passwordConfirmLimiter.mockImplementation((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
        res.status(429).json({ message: "Demasiados intentos. Espere unos minutos antes de volver a confirmar." });
      });
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it("never touches the budget when a factor already exists", async () => {
      // Constraint: the password is only accepted while tieneAlgunFactor is
      // false, checked before the password is even looked at. The budget is
      // part of "looking at the password", so it must not be spent either.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
      await requireStepUp()(req, res, next);

      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });

    it("never touches the budget for an onboarding session", async () => {
      const { req, res, next } = contexto(
        { id: 1, estado: "onboarding", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });

    it("never touches the budget when the window already satisfies the gate", async () => {
      const { req, res, next } = contexto({
        id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES - 1),
      });
      await requireStepUp()(req, res, next);

      expect(passwordConfirmLimiter).not.toHaveBeenCalled();
    });
  });
});
