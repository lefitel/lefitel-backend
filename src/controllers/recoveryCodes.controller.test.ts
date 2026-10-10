// `recoveryCodes.controller.ts` — the two thin HTTP wrappers around
// `auth/recoveryCodeStore.ts`, tested with `requireStepUp` already assumed to
// have run on the POST (its own suite is `requireStepUp.test.ts`; the wiring
// that actually mounts it on this route is
// `recoveryCodes.routes.test.ts`'s job, not this file's).
//
// `recoveryCodeStore.ts` itself is off-limits tonight — built and verified —
// so it is mocked here the same way `totp.controller.test.ts` mocks
// `totpStore.ts`: this file only proves what the controller decides on top
// of whatever the store returns, never re-proves bcrypt cost or the
// invalidate-and-replace transaction, which already have their own tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const regenerarCodigos = vi.fn();
const contarCodigosRestantes = vi.fn();
vi.mock("../auth/recoveryCodeStore.js", () => ({
  regenerarCodigos: (...a: unknown[]) => regenerarCodigos(...a),
  contarCodigosRestantes: (...a: unknown[]) => contarCodigosRestantes(...a),
}));

// Hallazgo F1: `regenerateRecoveryCodes` now checks the real module before
// ever calling the store above. Mocked the same way `totp.routes.test.ts`
// and `recoveryCodes.routes.test.ts` mock it, so this file proves what the
// *controller* does with each answer, never the two COUNTs behind it.
const tieneAlgunFactor = vi.fn();
vi.mock("../auth/factorInventory.js", () => ({ tieneAlgunFactor: (...a: unknown[]) => tieneAlgunFactor(...a) }));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));

vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  regenerateRecoveryCodes,
  countRecoveryCodes,
  MENSAJE_CODIGOS_GENERADOS,
  MENSAJE_SIN_FACTOR_PARA_CODIGOS,
} = await import("./recoveryCodes.controller.js");

const CALLER = {
  id: 7,
  id_rol: 2,
  id_sesion: "sesion-7",
  expires_at: new Date("2026-09-15T00:00:00Z"),
  estado: "completa" as const,
  mfa_satisfied_at: new Date("2026-09-01T00:00:00Z"),
  // Required on `req.user`, and null until somebody types their password
  // into `requireStepUp`: the ten-minute window of a factor-less account.
  password_confirmed_at: null,
};

const DIEZ_CODIGOS = Array.from({ length: 10 }, (_, i) => `CODIGO-${i}-${"X".repeat(20)}`);

function call(user: NonNullable<Request["user"]> | undefined, body: unknown = {}) {
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
    req: { user, body, ip: "203.0.113.9", originalUrl: "/api/auth/recovery-codes" } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as { message?: string; codigos?: string[]; restantes?: number };
    },
  };
}

beforeEach(() => {
  regenerarCodigos.mockReset().mockResolvedValue(DIEZ_CODIGOS);
  contarCodigosRestantes.mockReset().mockResolvedValue(3);
  // `true` by default: every pre-existing test in this file exercises an
  // account that already has a factor, and only the describe block below
  // narrows this to `false`.
  tieneAlgunFactor.mockReset().mockResolvedValue(true);
  logAction.mockReset();
});

describe("regenerateRecoveryCodes", () => {
  it("answers 401 when there is no caller", async () => {
    const c = call(undefined);
    await regenerateRecoveryCodes(c.req, c.res);
    expect(c.status).toBe(401);
    expect(regenerarCodigos).not.toHaveBeenCalled();
  });

  it("returns the ten codes from the store in the response body, exactly once", async () => {
    const c = call(CALLER);
    await regenerateRecoveryCodes(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload.message).toBe(MENSAJE_CODIGOS_GENERADOS);
    expect(c.payload.codigos).toEqual(DIEZ_CODIGOS);
  });

  it("asks the store for a fresh set scoped to the caller's own id, never anything from the body", async () => {
    const c = call(CALLER, { id_usuario: 999999 });
    await regenerateRecoveryCodes(c.req, c.res);
    expect(regenerarCodigos).toHaveBeenCalledWith(CALLER.id);
  });

  it("a second call returns whatever the store hands back that time, not a cached first answer", async () => {
    const primero = call(CALLER);
    await regenerateRecoveryCodes(primero.req, primero.res);
    expect(primero.payload.codigos).toEqual(DIEZ_CODIGOS);

    const OTROS_DIEZ = Array.from({ length: 10 }, (_, i) => `OTRO-${i}-${"Y".repeat(20)}`);
    regenerarCodigos.mockResolvedValue(OTROS_DIEZ);
    const segundo = call(CALLER);
    await regenerateRecoveryCodes(segundo.req, segundo.res);
    expect(segundo.payload.codigos).toEqual(OTROS_DIEZ);
    expect(regenerarCodigos).toHaveBeenCalledTimes(2);
  });

  it("writes a critical bitácora line naming the caller and session, with no code in detail or metadata", async () => {
    const c = call(CALLER);
    await regenerateRecoveryCodes(c.req, c.res);

    expect(logAction).toHaveBeenCalledTimes(1);
    const [entrada] = logAction.mock.calls[0] as [Record<string, unknown>];
    expect(entrada).toMatchObject({
      id_usuario: CALLER.id,
      action: "RECOVERY_CODES_REGENERATED",
      severity: "critical",
    });
    const serializada = JSON.stringify(entrada);
    for (const codigo of DIEZ_CODIGOS) {
      expect(serializada).not.toContain(codigo);
    }
  });

  it("🔴 never prints a code anywhere the bitácora call could carry it — mutation guard", async () => {
    // If a future edit ever passed `codigos` into `logAction`'s `metadata` —
    // the easy mistake when "log what happened" and "return what happened"
    // sit three lines apart — this is what turns that red instead of letting
    // it slip through as a plausible-looking audit trail.
    const c = call(CALLER);
    await regenerateRecoveryCodes(c.req, c.res);
    const [entrada] = logAction.mock.calls[0] as [{ metadata: unknown; detail: string }];
    expect(entrada.metadata).not.toHaveProperty("codigos");
    expect(entrada.detail).not.toMatch(/[A-Z0-9]{20,}/);
  });

  describe("🔴 hallazgo F1 — refuses an account with no confirmed factor at all", () => {
    it("answers 409 instead of issuing codes, and writes nothing", async () => {
      tieneAlgunFactor.mockResolvedValue(false);
      const c = call(CALLER);

      await regenerateRecoveryCodes(c.req, c.res);

      expect(c.status).toBe(409);
      expect(c.payload.message).toBe(MENSAJE_SIN_FACTOR_PARA_CODIGOS);
      expect(regenerarCodigos).not.toHaveBeenCalled();
      expect(logAction).not.toHaveBeenCalled();
    });

    it("checks the caller's own id, never anything from the body", async () => {
      tieneAlgunFactor.mockResolvedValue(false);
      const c = call(CALLER, { id_usuario: 999999 });

      await regenerateRecoveryCodes(c.req, c.res);

      expect(tieneAlgunFactor).toHaveBeenCalledWith(CALLER.id);
    });

    it("still issues the ten once the account has a factor — the ordinary case is unaffected", async () => {
      tieneAlgunFactor.mockResolvedValue(true);
      const c = call(CALLER);

      await regenerateRecoveryCodes(c.req, c.res);

      expect(c.status).toBe(200);
      expect(c.payload.codigos).toEqual(DIEZ_CODIGOS);
    });
  });
});

describe("countRecoveryCodes", () => {
  it("answers 401 when there is no caller", async () => {
    const c = call(undefined);
    await countRecoveryCodes(c.req, c.res);
    expect(c.status).toBe(401);
    expect(contarCodigosRestantes).not.toHaveBeenCalled();
  });

  it("returns the count from the store, scoped to the caller's own id", async () => {
    const c = call(CALLER);
    await countRecoveryCodes(c.req, c.res);

    expect(c.status).toBe(200);
    expect(c.payload.restantes).toBe(3);
    expect(contarCodigosRestantes).toHaveBeenCalledWith(CALLER.id);
  });

  it("returns zero when nothing is outstanding, and never writes to the bitácora", async () => {
    contarCodigosRestantes.mockResolvedValue(0);
    const c = call(CALLER);
    await countRecoveryCodes(c.req, c.res);

    expect(c.payload.restantes).toBe(0);
    expect(logAction).not.toHaveBeenCalled();
  });

  it("never returns anything shaped like a code, only a number", async () => {
    const c = call(CALLER);
    await countRecoveryCodes(c.req, c.res);
    expect(typeof c.payload.restantes).toBe("number");
    expect(Object.keys(c.payload)).toEqual(["restantes"]);
  });
});
