// `totp.routes.ts` — proving the *wiring*, not the business rules.
//
// `totp.controller.test.ts` already covers what `setupTotp`/`confirmTotp`/
// `deleteTotp` decide once `requireStepUp` has let a request through. What
// nothing proves without this file is that the router actually mounts that
// gate with the right options on the right route — `permiteOnboarding` on all
// three and `toleraFactorIlegible` on the DELETE alone are a configuration
// object handed to a function call, invisible to a typecheck and invisible to
// a test that only calls the controller directly.
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
/**
 * Mocked as a separate function rather than derived from `tieneAlgunFactor`
 * and `totpEstaDisponible`, deliberately: what *this* file is about is which
 * route reads it, and a mock that computed the answer would pass even if the
 * mount stopped asking. The real relationship between the two — that a
 * confirmed TOTP stops being verifiable when the keyring cannot read it — is
 * pinned in `factorInventory.test.ts`, where the function lives.
 */
const hayFactorVerificable = vi.fn();
/**
 * 🔴 Mocked because this file is the only one that walks the
 * `toleraFactorIlegible` fall-through, and that path accepts a password from
 * an account that **does** have a factor — one this server cannot read. The
 * gate must not open a password window there, and until the mock existed the
 * test below passed only because the real `sellarContrasena` was never
 * reached: an assertion nobody had written, held up by an implementation
 * detail. Now it is asserted, and the mock is what makes the assertion
 * possible without an UPDATE leaving for a real database.
 */
const sellarContrasena = vi.fn();
const logAction = vi.fn();
const passwordConfirmLimiter = vi.fn() as ReturnType<typeof vi.fn> & { getKey: ReturnType<typeof vi.fn> };
passwordConfirmLimiter.getKey = vi.fn();
const passwordConfirmKey = vi.fn();
vi.mock("../auth/credentials.js", () => ({ verifyOwnPassword: (...a: unknown[]) => verifyOwnPassword(...a) }));
vi.mock("../auth/sessionPromotion.js", () => ({
  sellarContrasena: (...a: unknown[]) => sellarContrasena(...a),
}));
vi.mock("../auth/factorInventory.js", () => ({
  tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactor(...a),
  hayFactorVerificable: (...a: unknown[]) => hayFactorVerificable(...a),
  // Añadido por el plan 4C: `requireStepUp` lo llama al rechazar con
  // `sin-factor-reciente`, para que el 403 diga con qué se puede cubrir.
  // Sin él aquí, el mock deja la función a `undefined` y la puerta revienta
  // en cuanto rechaza — ruidoso, no silencioso, que es lo que se quiere.
  metodosDeReautenticacion: async () => ["totp"],
}));
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
  // The ordinary world: whatever factor exists can be proved. The one test
  // that cares flips it.
  hayFactorVerificable.mockReset().mockResolvedValue(true);
  sellarContrasena.mockReset().mockResolvedValue(true);
  logAction.mockReset();
  passwordConfirmKey.mockReset().mockReturnValue("pc:totp");
  passwordConfirmLimiter.getKey.mockReset().mockResolvedValue(undefined);
  passwordConfirmLimiter.mockReset().mockImplementation((_req: unknown, _res: unknown, next: (e?: unknown) => void) => next());
});

describe("the availability gate (Decision 2)", () => {
  // 🔴 Hallazgo F6/B-5/E-5: this used to be `router.use(requireTotpKeyAvailable)`,
  // a pathless layer ahead of every route — including `DELETE /`, which does
  // not touch the encrypted secret at all. A wrong `MFA_ENCRYPTION_KEY_ACTIVE`
  // then made it impossible to remove the one factor that had gone dead,
  // because the removal route answered 503 too. The gate now mounts only on
  // `/setup` and `/confirm` — see the two tests right below.
  it("mounts ahead of the controller on /setup and /confirm, not as a pathless layer", () => {
    expect(routeChain("POST", "/setup")[0].name).toBe("requireTotpKeyAvailable");
    expect(routeChain("POST", "/confirm")[0].name).toBe("requireTotpKeyAvailable");
  });

  it("does not mount on DELETE / at all — deleting a factor needs no encryption key (hallazgo F6)", () => {
    const names = routeChain("DELETE", "/").map((h) => h.name);
    expect(names).not.toContain("requireTotpKeyAvailable");
  });

  it("is never a pathless router.use layer any more — that shape is exactly what applied it to DELETE before", () => {
    // The old bug was invisible to `routeChain` above by construction: a
    // pathless `router.use(requireTotpKeyAvailable)` sits in the router's own
    // top-level stack, outside any single route's `route.stack`, so it ran
    // ahead of *every* route — DELETE included — without ever showing up in
    // that route's own chain. This is the check that would catch a
    // regression back to that shape even though the two tests above,
    // reading only route-scoped chains, would not.
    const layers = (totpRoutes as unknown as { stack: ExpressLayer[] }).stack;
    const pathless = layers.filter((l) => l.route === undefined);
    expect(pathless.some((l) => l.handle.name === "requireTotpKeyAvailable")).toBe(false);
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

describe("🔴 the gate on all three routes (hallazgo C1, reopened by the decision of 2026-10-10)", () => {
  const RUTAS: Array<[string, string]> = [
    ["POST", "/setup"],
    ["POST", "/confirm"],
    ["DELETE", "/"],
  ];

  it.each(RUTAS)(
    "%s %s refuses without stepup_password, on an account with no factor and nothing fresh",
    async (method, path) => {
      const stepUpGate = stepUpGateOf(method, path);
      tieneAlgunFactor.mockResolvedValue(false);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        {},
      );

      await stepUpGate(req, res, next);

      // A factor-less account with no fresh window is asked for its password,
      // not waved through on the cookie alone: the "nothing to prove" branch
      // was deleted by Task 3 of the reauthentication-window plan.
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

  // 🔴 The lockout this route existed to prevent, and did not.
  //
  // `totp.routes.ts` leaves `requireTotpKeyAvailable` off this DELETE on
  // purpose — "para que una llave equivocada no encierre a nadie en un factor
  // muerto" — and then mounted a gate that asks for a code produced from that
  // same unreadable secret. The escape hatch stayed open and the door in front
  // of it was shut, which is worse than being closed: it looks fixed.
  //
  // Measured before `toleraFactorIlegible` existed: this assertion read
  // `MOTIVO_SIN_FACTOR_RECIENTE` for all three routes, and there was no way
  // for that person to reach `deleteTotp` at all except by spending a recovery
  // code they may never have generated.
  it("DELETE / stops demanding a factor the server has just said it cannot read", async () => {
    const stepUpGate = stepUpGateOf("DELETE", "/");
    tieneAlgunFactor.mockResolvedValue(true);
    hayFactorVerificable.mockResolvedValue(false);
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      {},
    );

    await stepUpGate(req, res, next);

    // Not `sin-factor-reciente`: that answer names a remedy this person cannot
    // perform. It falls through to the password branch instead.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
    );
    // And the fall-through is *not* a free pass: a stolen cookie with no
    // password still gets nothing. This request reached the password branch
    // and was refused there for sending none.
    expect(next).not.toHaveBeenCalled();
    // 🔴 And the fall-through leaves a trace, which is the only reason an
    // operator can count these during a key outage: the gate has just decided
    // to accept a password *in place of* a factor it declares unreadable, and
    // the line is written at the moment of that decision — before the password
    // is looked at, so it appears for a refused attempt like this one too.
    // Deliberate: what is worth counting is how many people the broken key
    // sent down this road, not how many of them got through.
    //
    // 🔴 **This assertion replaces a dead one.** It read
    // `.not.toHaveBeenCalledWith({ action: "STEP_UP_SKIPPED" })` until Task 17
    // of the reauthentication-window plan (2026-09-08). Task 3 of that same
    // plan had deleted the branch that emitted `STEP_UP_SKIPPED`, and nothing
    // writes that action anywhere any more — so the old line was true whatever
    // this gate did, and would have stayed true with the whole refusal above
    // deleted. `STEP_UP_FACTOR_ILEGIBLE` is what this path really writes, and
    // this is its only witness.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_FACTOR_ILEGIBLE", severity: "critical" }),
    );
  });

  it("DELETE / ignores a fresh password window while the factor is unreadable: the account has a factor", async () => {
    // `password_confirmed_at` is the window of an account with NO factor
    // (§5 of the design). This one has a factor, only unreadable, so the
    // column must not stand in for it: no password in the body is a refusal
    // even with the column a minute old.
    const stepUpGate = stepUpGateOf("DELETE", "/");
    tieneAlgunFactor.mockResolvedValue(true);
    hayFactorVerificable.mockResolvedValue(false);
    const { req, res, next } = contexto(
      {
        id: 1,
        id_sesion: "s1",
        estado: "completa",
        mfa_satisfied_at: null,
        password_confirmed_at: new Date(Date.now() - 60_000),
      },
      {},
    );

    await stepUpGate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
    );
  });

  it("DELETE / with the same unreadable factor lets the password through", async () => {
    const stepUpGate = stepUpGateOf("DELETE", "/");
    tieneAlgunFactor.mockResolvedValue(true);
    hayFactorVerificable.mockResolvedValue(false);
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );

    await stepUpGate(req, res, next);

    // The whole point: there *is* a way out, and it costs the password.
    expect(next).toHaveBeenCalled();
    expect(verifyOwnPassword).toHaveBeenCalled();

    // 🔴 And it opens **no ten-minute window**. This account has a factor —
    // the server just cannot read it — so the password is standing in for a
    // factor rather than replacing one that was never there. Sealing here
    // would hand a with-factor account a password window, which is the one
    // state the audit rules out: prove the factor once, then hold the
    // credential routes open on the password alone. Correct today because
    // `tieneFactor` is `true` on this path, and asserted here because
    // nothing else walks it.
    expect(sellarContrasena).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/setup"],
    ["POST", "/confirm"],
  ] as const)(
    "%s %s keeps demanding the factor even then — the option is one route wide",
    async (method, path) => {
      const stepUpGate = stepUpGateOf(method, path);
      tieneAlgunFactor.mockResolvedValue(true);
      hayFactorVerificable.mockResolvedValue(false);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "does-not-matter" },
      );

      await stepUpGate(req, res, next);

      // These two register a credential rather than undo one, so an unreadable
      // key is a reason to refuse, not a reason to accept a password instead.
      // If `toleraFactorIlegible` ever leaked onto them, this goes red.
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
      );
    },
  );
});

describe("🔴 permiteOnboarding: on for all three routes (hallazgo F6/E-5)", () => {
  // Before this fix, `DELETE /` mounted the gate with no `permiteOnboarding`, so an `onboarding` session — by construction
  // one with no *confirmed* factor — was refused at the state check with
  // "Termina de configurar tu segundo factor antes de realizar esta operación",
  // shown on the very screen that button lives on, right under "Añadir". The
  // correct answer for that account is the controller's own 404 ("no tienes
  // ningún factor"), which needs the state check to let the request through
  // first — exactly what `setup` and `confirm` already did.
  it.each([
    ["POST", "/setup"],
    ["POST", "/confirm"],
    ["DELETE", "/"],
  ] as const)("%s %s lets an onboarding session past the state check", async (method, path) => {
    const stepUpGate = stepUpGateOf(method, path);
    tieneAlgunFactor.mockResolvedValue(false);
    const { req, res, next } = contexto({ id: 1, estado: "onboarding", mfa_satisfied_at: null }, {});

    await stepUpGate(req, res, next);

    // Reaches the password branch (still refused, since none was sent) —
    // proving the *state* check passed. `DELETE` is no different: an
    // onboarding session's cookie alone gets no free pass, it is asked for
    // its password like a factor-less `completa` session.
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
    );
  });

  it("still refuses `parcial` outright on all three routes — permiteOnboarding never widens past onboarding", async () => {
    for (const [method, path] of [["POST", "/setup"], ["POST", "/confirm"], ["DELETE", "/"]] as const) {
      const stepUpGate = stepUpGateOf(method, path);
      const { req, res, next } = contexto({ id: 1, estado: "parcial", mfa_satisfied_at: null }, {});

      await stepUpGate(req, res, next);

      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
      expect(res.json, `${method} ${path}`).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
      );
    }
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
      expect(names).toContain("authenticate");
      expect(names.indexOf("authenticate")).toBeLessThan(names.indexOf("stepUpGate"));
      expect(names[names.length - 1]).toMatch(/^(setupTotp|confirmTotp|deleteTotp)$/);
    }
  });

  it("setup and confirm carry requireTotpKeyAvailable ahead of authenticate; delete carries none (hallazgo F6)", () => {
    for (const [method, path] of [["POST", "/setup"], ["POST", "/confirm"]] as const) {
      const names = routeChain(method, path).map((h) => h.name);
      expect(names.indexOf("requireTotpKeyAvailable"), `${method} ${path}`).toBe(0);
      expect(names.indexOf("authenticate"), `${method} ${path}`).toBe(1);
    }
    expect(routeChain("DELETE", "/").map((h) => h.name)).not.toContain("requireTotpKeyAvailable");
  });
});
