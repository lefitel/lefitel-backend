// `totp.routes.ts` — proving the *wiring*, not the business rules.
//
// `totp.controller.test.ts` already covers what `setupTotp`/`confirmTotp`/
// `deleteTotp` decide once `requireStepUp` has let a request through. What
// nothing proves without this file is that the router actually mounts that
// gate with the right options on the right route — the single line hallazgo
// C1 exists because of ("`requireStepUp` gana `exigeContrasena: true`") is a
// configuration object handed to a function call, invisible to a typecheck
// and invisible to a test that only calls the controller directly.
//
// So this file pulls the *real* middleware instances back out of the router
// exactly as `totp.routes.ts` built them — via Express's own `stack`, the
// same mechanism `routeGuards.test.ts` uses on the whole app — and calls them
// the way `requireStepUp.test.ts` already does: with a bare fake req/res, not
// through Express or supertest. `authenticate` is mocked to a no-op (nothing
// here exercises session lookup); `requireStepUp` itself is **not** mocked,
// because the whole point is to prove the configuration that reaches it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../middleware/authenticate.js", () => ({
  authenticate: Object.defineProperty(
    (_req: Request, _res: Response, next: NextFunction) => next(),
    "name",
    { value: "authenticate" },
  ),
}));

const setupTotp = Object.defineProperty(vi.fn((_req: Request, res: Response) => res.status(200).json({ h: "setup" })), "name", { value: "setupTotp" });
const confirmTotp = Object.defineProperty(vi.fn((_req: Request, res: Response) => res.status(200).json({ h: "confirm" })), "name", { value: "confirmTotp" });
const deleteTotp = Object.defineProperty(vi.fn((_req: Request, res: Response) => res.status(200).json({ h: "delete" })), "name", { value: "deleteTotp" });
vi.mock("../controllers/totp.controller.js", () => ({ setupTotp, confirmTotp, deleteTotp }));

const totpEstaDisponible = vi.fn();
vi.mock("../auth/mfaKeyCheck.js", () => ({ totpEstaDisponible: () => totpEstaDisponible() }));

// The same four dependencies `requireStepUp.test.ts` mocks, for the same
// reason: `requireStepUp.ts` is used for real below, and these are what it
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

const totpRoutes = (await import("./totp.routes.js")).default;
const { requireTotpKeyAvailable, MENSAJE_TOTP_NO_DISPONIBLE } = await import("./totp.routes.js");
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
  const layers = (totpRoutes as unknown as { stack: ExpressLayer[] }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer?.route) {
    throw new Error(`no se encontró la ruta ${method} ${path} en totp.routes.ts`);
  }
  return layer.route.stack.map((s) => s.handle);
}

function stepUpGateOf(method: string, path: string): Handle {
  const found = routeChain(method, path).find((h) => h.name === "stepUpGate");
  if (!found) throw new Error(`${method} ${path} no monta requireStepUp (nombre "stepUpGate" ausente)`);
  return found;
}

/** Same shape `requireStepUp.test.ts` builds its fixtures with. */
function contexto(user: Record<string, unknown> | undefined, body: unknown = {}) {
  const req = { user, body, ip: "203.0.113.9", originalUrl: "/api/auth/totp/x" } as unknown as Request;
  const r = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: {} };
  const res = r as unknown as Response & typeof r;
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  totpEstaDisponible.mockReset().mockReturnValue(true);
  verifyOwnPassword.mockReset();
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  logAction.mockReset();
  passwordConfirmKey.mockReset().mockReturnValue("pc:totp");
  passwordConfirmLimiter.getKey.mockReset().mockResolvedValue(undefined);
  passwordConfirmLimiter.mockReset().mockImplementation((_req: unknown, _res: unknown, next: (e?: unknown) => void) => next());
});

describe("the availability gate (Decision 2)", () => {
  it("is mounted first, ahead of every route, as a pathless layer", () => {
    const layers = (totpRoutes as unknown as { stack: ExpressLayer[] }).stack;
    expect(layers[0].route).toBeUndefined();
    expect(layers[0].handle.name).toBe("requireTotpKeyAvailable");
  });

  it("answers 503 with a message that does not blame the caller, and never calls next", async () => {
    totpEstaDisponible.mockReturnValue(false);
    const { req, res, next } = contexto({ id: 1 });
    await requireTotpKeyAvailable(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ message: MENSAJE_TOTP_NO_DISPONIBLE });
    expect(next).not.toHaveBeenCalled();
  });

  it("lets the request through once the key checks out", async () => {
    totpEstaDisponible.mockReturnValue(true);
    const { req, res, next } = contexto({ id: 1 });
    await requireTotpKeyAvailable(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("🔴 exigeContrasena on all three routes (hallazgo C1)", () => {
  const RUTAS: Array<[string, string]> = [
    ["POST", "/setup"],
    ["POST", "/confirm"],
    ["DELETE", "/"],
  ];

  it.each(RUTAS)(
    "%s %s refuses without stepup_password, even on an account with no factor at all",
    async (method, path) => {
      const stepUpGate = stepUpGateOf(method, path);
      tieneAlgunFactor.mockResolvedValue(false);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        {},
      );

      await stepUpGate(req, res, next);

      // 🔴 Without `exigeContrasena: true` this account — no factor, no fresh
      // proof needed — would simply be waved through by `requireStepUp`'s own
      // "nothing to prove" branch. Mutating the mount to `requireStepUp()`
      // with no options turns this into `next()` and the assertion below
      // goes red — confirmed while building this task, see the O-report.
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
      );
    },
  );

  it.each(RUTAS)(
    "%s %s still refuses an account with an unproven factor before ever asking for a password",
    async (method, path) => {
      const stepUpGate = stepUpGateOf(method, path);
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "does-not-matter" },
      );

      await stepUpGate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
      );
    },
  );
});

describe("🔴 permiteOnboarding: on for setup/confirm, off for delete", () => {
  it.each([
    ["POST", "/setup"],
    ["POST", "/confirm"],
  ] as const)("%s %s lets an onboarding session past the state check", async (method, path) => {
    const stepUpGate = stepUpGateOf(method, path);
    tieneAlgunFactor.mockResolvedValue(false);
    const { req, res, next } = contexto({ id: 1, estado: "onboarding", mfa_satisfied_at: null }, {});

    await stepUpGate(req, res, next);

    // Reaches the password branch (still refused, since none was sent) —
    // proving the *state* check passed, without needing `exigeContrasena`
    // turned off to observe it.
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
    );
  });

  it("DELETE / refuses an onboarding session outright, at the state check", async () => {
    const stepUpGate = stepUpGateOf("DELETE", "/");
    const { req, res, next } = contexto({ id: 1, estado: "onboarding", mfa_satisfied_at: null }, {});

    await stepUpGate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
    );
  });
});

describe("route shape", () => {
  it("setup and confirm are POST, delete is DELETE — nothing here is a GET a secret could ride in on", () => {
    expect(() => routeChain("POST", "/setup")).not.toThrow();
    expect(() => routeChain("POST", "/confirm")).not.toThrow();
    expect(() => routeChain("DELETE", "/")).not.toThrow();
    expect(() => routeChain("GET", "/setup")).toThrow();
    expect(() => routeChain("GET", "/confirm")).toThrow();
  });

  it("every route carries authenticate ahead of the controller handler", () => {
    for (const [method, path] of [["POST", "/setup"], ["POST", "/confirm"], ["DELETE", "/"]] as const) {
      const names = routeChain(method, path).map((h) => h.name);
      expect(names[0]).toBe("authenticate");
      expect(names[names.length - 1]).toMatch(/^(setupTotp|confirmTotp|deleteTotp)$/);
    }
  });
});
