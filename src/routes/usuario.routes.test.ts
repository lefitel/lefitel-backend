// `usuario.routes.ts` — proving the *wiring* of one thing only: that
// `PATCH /:id/desbloquear` and `POST /:id/mfa/reset` mount `requireStepUp`
// with `exigeContrasena: true` — hallazgo F8 of the 2026-09-02 closure audit.
//
// Not a full wiring suite for this router. `routeGuards.test.ts` already
// proves, across the whole app, that both routes carry `requirePermissionGate`
// ahead of `stepUpGate` and that both are members of `STEP_UP_GATED` — and it
// is structurally blind to *which options* reach `requireStepUp()`, the same
// gap hallazgo C1 exercised on `totp.routes.ts` before this file existed for
// `usuario.routes.ts`: a configuration object handed to a function call is
// invisible to a typecheck and invisible to a test that only calls the
// controller directly. This file is that missing proof, scoped to the two
// mounts F8 actually changed.
//
// Same technique `totp.routes.test.ts` and `recoveryCodes.routes.test.ts`
// already use: pull the real middleware instances back out of the router via
// Express's own `stack` and call them with a bare fake req/res, never through
// Express or supertest. `authenticate` and the controller handlers are
// mocked to no-ops; `requireStepUp` itself is **not** mocked, because the
// whole point is to prove the configuration that reaches it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../middleware/authenticate.js", () => ({
  authenticate: Object.defineProperty(
    (_req: Request, _res: Response, next: NextFunction) => next(),
    "name",
    { value: "authenticate" },
  ),
}));

// Every export `usuario.routes.ts` imports from the controller, stubbed out
// so importing the real router never pulls in `UsuarioModel`, `RolModel` or
// a real database connection — none of which this file has any business
// touching to prove a configuration object.
function stub(name: string) {
  return Object.defineProperty(
    vi.fn((_req: Request, res: Response) => res.status(200).json({ h: name })),
    "name",
    { value: name },
  );
}
vi.mock("../controllers/usuario.controller.js", () => ({
  createUsuario: stub("createUsuario"),
  deleteUsuario: stub("deleteUsuario"),
  desarchivarUsuario: stub("desarchivarUsuario"),
  desbloquearUsuario: stub("desbloquearUsuario"),
  getUsuario: stub("getUsuario"),
  rescatarMfaDeUsuario: stub("rescatarMfaDeUsuario"),
  searchUsuario: stub("searchUsuario"),
  searchUsuario_user: stub("searchUsuario_user"),
  // Not a handler — read synchronously by `chargeConfirmBudgetOnSelfChange`,
  // which sits on neither route this file exercises. `false` keeps it out of
  // the way rather than expressing anything about it.
  requiresOwnPassword: () => false,
  updateUserName: stub("updateUserName"),
  updateUserPass: stub("updateUserPass"),
  updateUsuario: stub("updateUsuario"),
}));

// The same four dependencies `totp.routes.test.ts` and
// `recoveryCodes.routes.test.ts` mock, for the same reason: `requireStepUp.ts`
// runs for real below, and these are what it would otherwise touch a
// database or a real limiter through. `requirePermission.js` is left real —
// its own check is never invoked here, only looked past to reach
// `stepUpGate` by name, and importing it touches no database at module load.
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

const usuarioRoutes = (await import("./usuario.routes.js")).default;
const { MOTIVO_CONTRASENA_REQUERIDA } = await import("../middleware/requireStepUp.js");

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
  const layers = (usuarioRoutes as unknown as { stack: ExpressLayer[] }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer?.route) {
    throw new Error(`no se encontró la ruta ${method} ${path} en usuario.routes.ts`);
  }
  return layer.route.stack.map((s) => s.handle);
}

function stepUpGateOf(method: string, path: string): Handle | undefined {
  return routeChain(method, path).find((h) => h.name === "stepUpGate");
}

/** Same shape `totp.routes.test.ts` and `recoveryCodes.routes.test.ts` build their fixtures with. */
function contexto(user: Record<string, unknown> | undefined, body: unknown = {}) {
  const req = {
    user,
    body,
    params: { id: "42" },
    ip: "203.0.113.9",
    originalUrl: "/api/usuario/42",
  } as unknown as Request;
  const r = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: {} };
  const res = r as unknown as Response & typeof r;
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  verifyOwnPassword.mockReset();
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  logAction.mockReset();
  passwordConfirmKey.mockReset().mockReturnValue("pc:usuario-routes");
  passwordConfirmLimiter.getKey.mockReset().mockResolvedValue(undefined);
  passwordConfirmLimiter.mockReset().mockImplementation((_req: unknown, _res: unknown, next: (e?: unknown) => void) => next());
});

describe("🔴 PATCH /:id/desbloquear and POST /:id/mfa/reset demand the password — hallazgo F8", () => {
  for (const [method, path] of [
    ["PATCH", "/:id/desbloquear"],
    ["POST", "/:id/mfa/reset"],
  ] as const) {
    describe(`${method} ${path}`, () => {
      it("mounts requireStepUp at all", () => {
        expect(stepUpGateOf(method, path)).toBeDefined();
      });

      it("refuses with no stepup_password, even though no account anywhere has a factor yet", async () => {
        const stepUpGate = stepUpGateOf(method, path);
        if (!stepUpGate) throw new Error(`${method} ${path} no monta requireStepUp`);
        // Zero of nine accounts have a factor today — this is that exact,
        // real state, not a contrived edge case.
        tieneAlgunFactor.mockResolvedValue(false);
        const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});

        await stepUpGate(req, res, next);

        // 🔴 Before hallazgo F8's fix, `requireStepUp()` carried no options
        // here: a factor-less account's third branch would wave this
        // through with no password at all. Mutating the mount back to
        // `requireStepUp()` turns this into `next()` and the assertions
        // below go red.
        expect(next).not.toHaveBeenCalled();
        expect(verifyOwnPassword).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
        );
      });

      it("lets the request through once the caller's own current password is supplied", async () => {
        const stepUpGate = stepUpGateOf(method, path);
        if (!stepUpGate) throw new Error(`${method} ${path} no monta requireStepUp`);
        tieneAlgunFactor.mockResolvedValue(false);
        verifyOwnPassword.mockResolvedValue({ ok: true });
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "la-de-verdad" },
        );

        await stepUpGate(req, res, next);

        expect(verifyOwnPassword).toHaveBeenCalledWith(
          expect.objectContaining({ id: 1, pass: "la-de-verdad" }),
        );
        expect(next).toHaveBeenCalledTimes(1);
      });
    });
  }
});
