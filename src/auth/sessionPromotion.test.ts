// Promoting the session that proved a factor, and clearing the grace deadline.
//
// Both models are mocked exactly the way `sessionStore.test.ts` mocks
// `SesionModel`: nothing here reaches `osefi_local`, and Task 15's shared
// harness is not needed because this module is exercised directly, never
// through `app.auth.test.ts`'s route-level mocks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const sesionUpdate = vi.fn();
const usuarioUpdate = vi.fn();

vi.mock("../models/sesion.model.js", () => ({
  SesionModel: { update: (...a: unknown[]) => sesionUpdate(...a) },
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { update: (...a: unknown[]) => usuarioUpdate(...a) },
}));

const { promoverSesion, apagarLaMecha } = await import("./sessionPromotion.js");

/** The bound of a `{ [Op.x]: value }` clause, read past the Symbol key. */
const boundOf = (clause: unknown, op: symbol) => (clause as Record<symbol, unknown>)[op];
/** The operators actually present on a `{ [Op.x]: value }` clause. */
const opsOf = (clause: unknown) => Object.getOwnPropertySymbols(clause as object);

beforeEach(() => {
  vi.clearAllMocks();
  sesionUpdate.mockResolvedValue([1]);
  usuarioUpdate.mockResolvedValue([1]);
});

describe("promoverSesion", () => {
  it("promotes a partial session to complete", async () => {
    sesionUpdate.mockResolvedValue([1]);
    expect(await promoverSesion("s1", "totp")).toBe(true);

    const [values] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(values.estado).toBe("completa");
    expect(values.mfa_satisfied_at).toBeInstanceOf(Date);
    expect(values.mfa_source).toBe("totp");
  });

  it("promotes an onboarding session to complete", async () => {
    // Decision 8's actual point, and the one detail hallazgo C15's own table
    // gets wrong (it names only 'parcial'): `estadoInicialDeSesion` can open
    // a session in *either* state, so the WHERE has to reach both. Narrowing
    // this back to `['parcial']` would compile, pass the test above, and
    // silently strand every `onboarding` session at the fourteen-day cliff
    // even after it proves its factor — which is exactly hallazgo D2.
    await promoverSesion("s1", "totp");

    const [, options] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    const clause = options.where.estado;
    expect(opsOf(clause)).toContain(Op.in);
    expect(boundOf(clause, Op.in)).toEqual(expect.arrayContaining(["parcial", "onboarding"]));
  });

  it("refuses to promote a session that is not the caller's own", async () => {
    // There is no id_usuario parameter to cross-check against here — the
    // only thing standing between this function and promoting a stranger's
    // session is that the WHERE names *exactly* the id it was given, nothing
    // wider. `toEqual` on the whole where, not `toMatchObject`, so an
    // implementation that drops `id` and filters on `estado` alone — which
    // would promote *every* parcial/onboarding row in the table, "the
    // caller's own" included only by accident — fails this test even though
    // it would still pass the two tests above.
    await promoverSesion("mine", "totp");
    const [, first] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(Object.keys(first.where).sort()).toEqual(["estado", "id"]);
    expect(first.where.id).toBe("mine");

    // And the WHERE is rebuilt from this call's own argument every time,
    // never cached, defaulted, or left over from a previous caller's session.
    sesionUpdate.mockClear();
    await promoverSesion("someone-elses", "codigo");
    const [, second] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(second.where.id).toBe("someone-elses");
    expect(second.where.id).not.toBe("mine");
  });

  it("leaves an already complete session alone", async () => {
    // estado IN (...) excludes 'completa', so a session already promoted
    // matches nothing — this is what makes calling this twice idempotent
    // instead of re-stamping mfa_satisfied_at over a session that was
    // already satisfied.
    sesionUpdate.mockResolvedValue([0]);
    expect(await promoverSesion("s1", "totp")).toBe(false);
  });
});

describe("apagarLaMecha", () => {
  it("clears mfa_grace_until when the first factor is registered", async () => {
    await apagarLaMecha(7);

    const [values, options] = usuarioUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(values).toEqual({ mfa_grace_until: null });
    expect(options.where).toEqual({ id: 7 });
  });

  it("joins a transaction it is handed, so a spent code and its seal commit together", async () => {
    // Spending a recovery code and sealing the session it just proved must
    // commit or fail as one: a code consumed without a seal costs somebody one
    // of ten and leaves no trace of why. `gastarCodigo` already takes a
    // transaction for this; without the same parameter here the pair cannot be
    // closed at all.
    const t = { LOCK: "fake" } as never;
    sesionUpdate.mockResolvedValue([1]);

    await promoverSesion("s-1", "codigo", { transaction: t });

    expect(sesionUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transaction: t }),
    );
  });

  it("works with no transaction at all, which is the TOTP path", async () => {
    // The other direction: one statement composed with nothing needs no
    // transaction, and making the parameter required would have forced every
    // caller to invent one.
    sesionUpdate.mockResolvedValue([1]);

    await promoverSesion("s-1", "totp");

    expect(sesionUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transaction: undefined }),
    );
  });
});
