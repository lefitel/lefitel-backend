// `recoveryCodes.routes.ts` — proving the *wiring*, not the business rules.
//
// `recoveryCodes.controller.test.ts` already covers what
// `regenerateRecoveryCodes`/`countRecoveryCodes` decide once whatever gate
// this router puts in front of them has let a request through. What nothing
// proves without this file is that the router actually mounts — or does not
// mount — `requireStepUp` with the right options on the right method, which
// is a configuration object handed to a function call: invisible to a
// typecheck and invisible to a test that only calls the controller directly.
//
// Same technique `totp.routes.test.ts` already uses: pull the real
// middleware instances back out of the router via Express's own `stack` and
// call them with a bare fake req/res, never through Express or supertest.
// `authenticate` is mocked to a no-op; `requireStepUp` itself is **not**
// mocked, because the whole point is to prove the configuration that reaches
// it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../middleware/authenticate.js", () => ({
  authenticate: Object.defineProperty(
    (_req: Request, _res: Response, next: NextFunction) => next(),
    "name",
    { value: "authenticate" },
  ),
}));

const regenerateRecoveryCodes = Object.defineProperty(
  vi.fn((_req: Request, res: Response) => res.status(200).json({ h: "regenerate" })),
  "name",
  { value: "regenerateRecoveryCodes" },
);
const countRecoveryCodes = Object.defineProperty(
  vi.fn((_req: Request, res: Response) => res.status(200).json({ h: "count" })),
  "name",
  { value: "countRecoveryCodes" },
);
vi.mock("../controllers/recoveryCodes.controller.js", () => ({
  regenerateRecoveryCodes,
  countRecoveryCodes,
}));

// The same four dependencies `totp.routes.test.ts` mocks, for the same
// reason: `requireStepUp.ts` runs for real below, and these are what it
// would otherwise touch a database or a real limiter through.
const verifyOwnPassword = vi.fn();
const tieneAlgunFactor = vi.fn();
const logAction = vi.fn();
const passwordConfirmLimiter = vi.fn() as ReturnType<typeof vi.fn> & { getKey: ReturnType<typeof vi.fn> };
passwordConfirmLimiter.getKey = vi.fn();
const passwordConfirmKey = vi.fn();
vi.mock("../auth/credentials.js", () => ({ verifyOwnPassword: (...a: unknown[]) => verifyOwnPassword(...a) }));
vi.mock("../auth/factorInventory.js", () => ({ tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactor(...a) }));
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
vi.mock("../middleware/loginLimiters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/loginLimiters.js")>();
  return { ...actual, passwordConfirmLimiter, passwordConfirmKey };
});

const recoveryCodesRoutes = (await import("./recoveryCodes.routes.js")).default;
const {
  MOTIVO_ESTADO_INCOMPLETO,
  MOTIVO_SIN_FACTOR_RECIENTE,
  MOTIVO_CONTRASENA_REQUERIDA,
} = await import("../middleware/requireStepUp.js");

type Handle = (req: Request, res: Response, next: NextFunction) => unknown;

interface ExpressLayer {
  handle: Handle & { name: string };
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: Handle & { name: string } }[];
  };
}

function routeChain(method: string, path: string): (Handle & { name: string })[] {
  const layers = (recoveryCodesRoutes as unknown as { stack: ExpressLayer[] }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer?.route) {
    throw new Error(`no se encontró la ruta ${method} ${path} en recoveryCodes.routes.ts`);
  }
  return layer.route.stack.map((s) => s.handle);
}

function stepUpGateOf(method: string, path: string): Handle | undefined {
  return routeChain(method, path).find((h) => h.name === "stepUpGate");
}

/** Same shape `totp.routes.test.ts` builds its fixtures with. */
function contexto(user: Record<string, unknown> | undefined, body: unknown = {}) {
  const req = {
    user,
    body,
    ip: "203.0.113.9",
    originalUrl: "/api/auth/recovery-codes",
  } as unknown as Request;
  const r = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: {} };
  const res = r as unknown as Response & typeof r;
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  verifyOwnPassword.mockReset();
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  logAction.mockReset();
  passwordConfirmKey.mockReset().mockReturnValue("pc:recovery-codes");
  passwordConfirmLimiter.getKey.mockReset().mockResolvedValue(undefined);
  passwordConfirmLimiter.mockReset().mockImplementation((_req: unknown, _res: unknown, next: (e?: unknown) => void) => next());
});

describe("🔴 POST / demands the password, always — hallazgo C14", () => {
  it("refuses without stepup_password, even on an account with no factor at all", async () => {
    const stepUpGate = stepUpGateOf("POST", "/");
    if (!stepUpGate) throw new Error("POST / no monta requireStepUp (nombre \"stepUpGate\" ausente)");
    tieneAlgunFactor.mockResolvedValue(false);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});

    await stepUpGate(req, res, next);

    // 🔴 Without `exigeContrasena: true` this account — no factor, no fresh
    // proof needed — would simply be waved through by `requireStepUp`'s own
    // "nothing to prove" branch. Mutating the mount to `requireStepUp()` with
    // no options turns this into `next()` and the assertion below goes red.
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }));
  });

  it("refuses a fresh recovery-code proof too — a `codigo` field in the session state does not exist, but a fresh mfa_satisfied_at from one does, and it still is not enough on its own", async () => {
    const stepUpGate = stepUpGateOf("POST", "/");
    if (!stepUpGate) throw new Error("POST / no monta requireStepUp");
    tieneAlgunFactor.mockResolvedValue(true);
    // A session that just proved a factor — recovery code included — inside
    // the ten-minute window. Without `exigeContrasena`, `requireStepUp`'s
    // first branch (`satisfecho && !exigeContrasena`) would let this straight
    // through with no password at all — exactly the "printed sheet is a
    // master key" shape hallazgo C14 warns about.
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: new Date().toISOString() },
      {},
    );

    await stepUpGate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }));
  });

  it("still refuses an account with an unproven factor before ever asking for a password", async () => {
    const stepUpGate = stepUpGateOf("POST", "/");
    if (!stepUpGate) throw new Error("POST / no monta requireStepUp");
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "does-not-matter" },
    );

    await stepUpGate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }));
  });

  it("🔴 refuses an onboarding session outright at the state check — hallazgo F1, `permiteOnboarding` removed", async () => {
    // This mount used to carry `permiteOnboarding: true`. It does not any
    // more: `onboarding` means no confirmed factor by construction (see
    // `factorInventory.ts`'s `estadoInicialDeSesion`), and the controller
    // now refuses exactly that account regardless of state — see
    // `recoveryCodes.controller.ts`'s own guard and its test. Letting an
    // `onboarding` session past this gate only bought it a chance to type a
    // password on a request that was always going to end in a 409, so the
    // option was removed rather than kept as a detour to the same refusal.
    const stepUpGate = stepUpGateOf("POST", "/");
    if (!stepUpGate) throw new Error("POST / no monta requireStepUp");
    const { req, res, next } = contexto({ id: 1, estado: "onboarding", mfa_satisfied_at: null }, {});

    await stepUpGate(req, res, next);

    // Refused at the very first check, before the factor lookup or the
    // password field are ever read.
    expect(next).not.toHaveBeenCalled();
    expect(tieneAlgunFactor).not.toHaveBeenCalled();
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }));
  });

  it("refuses a parcial session outright at the state check — belt and suspenders alongside sessionState.ts", async () => {
    // In production a `parcial` session never reaches this far:
    // `auth/sessionState.ts` keeps `/api/auth/recovery-codes` out of `PARCIAL`
    // (not modified by this task — verified, not assumed), so `authenticate`
    // itself answers 403 first. This test exercises the second, independent
    // layer: `requireStepUp`'s own state check refuses `parcial` regardless,
    // the same way it would if that upstream list were ever misconfigured.
    const stepUpGate = stepUpGateOf("POST", "/");
    if (!stepUpGate) throw new Error("POST / no monta requireStepUp");
    const { req, res, next } = contexto({ id: 1, estado: "parcial", mfa_satisfied_at: null }, {});

    await stepUpGate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }));
  });
});

describe("route shape", () => {
  it("POST is the only write; GET carries no requireStepUp", () => {
    expect(() => routeChain("POST", "/")).not.toThrow();
    expect(() => routeChain("GET", "/")).not.toThrow();
    expect(stepUpGateOf("POST", "/")).toBeDefined();
    expect(stepUpGateOf("GET", "/")).toBeUndefined();
  });

  it("both routes carry authenticate ahead of the controller handler", () => {
    for (const [method, path] of [
      ["POST", "/"],
      ["GET", "/"],
    ] as const) {
      const names = routeChain(method, path).map((h) => h.name);
      expect(names[0]).toBe("authenticate");
      expect(names[names.length - 1]).toMatch(/^(regenerateRecoveryCodes|countRecoveryCodes)$/);
    }
  });

  it("GET / reaches the controller with nothing else in between but authenticate", () => {
    const names = routeChain("GET", "/").map((h) => h.name);
    expect(names).toEqual(["authenticate", "countRecoveryCodes"]);
  });
});
