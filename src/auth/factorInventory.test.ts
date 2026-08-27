// `factoresDe` and `tieneAlgunFactor` — written whole in Task 6 rather than
// stubbed, because `requireStepUp` needs a real answer from the first
// request it ever gates and a branch first exercised in production is a
// branch nobody has run. Two rules are load-bearing enough to need their own
// test each: an unconfirmed TOTP secret is not a factor, and a pile of
// recovery codes alone is not one either. See factorInventory.ts's own
// comment for why.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const passkeyCount = vi.fn();
const totpCount = vi.fn();
const codigoCount = vi.fn();

vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: { count: (...args: unknown[]) => passkeyCount(...args) },
}));
vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: { count: (...args: unknown[]) => totpCount(...args) },
}));
vi.mock("../models/codigoRecuperacion.model.js", () => ({
  CodigoRecuperacionModel: { count: (...args: unknown[]) => codigoCount(...args) },
}));

const { factoresDe, tieneAlgunFactor, estadoInicialDeSesion } = await import(
  "./factorInventory.js"
);
const { MFA_GRACE_DAYS } = await import("../config/security.js");

const YO = 1;
const DIA = 24 * 60 * 60 * 1000;

beforeEach(() => {
  passkeyCount.mockReset().mockResolvedValue(0);
  totpCount.mockReset().mockResolvedValue(0);
  codigoCount.mockReset().mockResolvedValue(0);
});

describe("factoresDe", () => {
  it("returns zero for every kind on an account with nothing registered", async () => {
    // The tables are empty today — this is the true answer, not a stub.
    expect(await factoresDe(YO)).toEqual({ passkeys: 0, totp: 0, codigos: 0 });
  });

  it("counts every passkey the account has registered, scoped to that account", async () => {
    passkeyCount.mockResolvedValue(2);
    expect((await factoresDe(YO)).passkeys).toBe(2);
    expect(passkeyCount).toHaveBeenCalledWith({ where: { id_usuario: YO } });
  });

  it("asks the database for confirmed TOTP secrets only, not merely existing ones", async () => {
    // The rule lives in the WHERE clause itself, not in a filter applied
    // afterwards that somebody could accidentally skip when adding a new
    // caller.
    await factoresDe(YO);
    expect(totpCount).toHaveBeenCalledWith({
      where: { id_usuario: YO, confirmed_at: { [Op.ne]: null } },
    });
  });

  it("asks the database for unredeemed recovery codes only", async () => {
    await factoresDe(YO);
    expect(codigoCount).toHaveBeenCalledWith({ where: { id_usuario: YO, used_at: null } });
  });
});

describe("tieneAlgunFactor", () => {
  it("is false for an account with nothing registered", async () => {
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("is true with a passkey and nothing else", async () => {
    passkeyCount.mockResolvedValue(1);
    expect(await tieneAlgunFactor(YO)).toBe(true);
  });

  it("is true with a confirmed TOTP factor", async () => {
    totpCount.mockResolvedValue(1);
    expect(await tieneAlgunFactor(YO)).toBe(true);
  });

  it("does NOT count an unconfirmed TOTP secret as a factor", async () => {
    // Modelled truthfully here as a zero count, not as a row this function
    // chooses to ignore — the exclusion lives in the WHERE clause the next
    // test pins, not in this test's own mock.
    //
    // A secret generated and never typed back is a QR somebody may have
    // failed to scan; counting it would demand a code they cannot produce.
    totpCount.mockResolvedValue(0);
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("asks the database for confirmed TOTP secrets only, in its own query", async () => {
    // `tieneAlgunFactor` runs its own `FactorTotpModel.count`, separate from
    // `factoresDe`'s — see that function's own comment for why. That split
    // means `factoresDe`'s own test of this WHERE shape no longer proves
    // anything about *this* function's query: dropping `confirmed_at` from
    // `tieneAlgunFactor` alone left every other test in this describe block
    // green, because none of them look at what was actually asked for, only
    // at the mocked answer. This is the one that would have caught it.
    await tieneAlgunFactor(YO);
    expect(totpCount).toHaveBeenCalledWith({
      where: { id_usuario: YO, confirmed_at: { [Op.ne]: null } },
    });
  });

  it("does NOT count recovery codes alone as a factor, however many there are", async () => {
    // Load-bearing: without this exclusion, onboarding could be finished
    // with a sheet of paper and nothing registered.
    codigoCount.mockResolvedValue(8);
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("is true even when recovery codes are also present, for the right reason", async () => {
    // Proves the OR is `passkeys > 0 || totp > 0` and not something that
    // happens to look right only when codigos is zero.
    totpCount.mockResolvedValue(1);
    codigoCount.mockResolvedValue(8);
    expect(await tieneAlgunFactor(YO)).toBe(true);
  });

  it("never queries the recovery-code table at all, on the hot path of every gated write", async () => {
    // `factoresDe` pays for all three tables because it answers a broader
    // question; this function answers a narrower one and only asks the two
    // tables that question is actually about. The tests above already prove
    // codes never flip the answer — this proves the query for them was never
    // sent in the first place, which is the round trip this fix removed.
    await tieneAlgunFactor(YO);
    expect(codigoCount).not.toHaveBeenCalled();
  });
});

// Which of the three states a session opens in, and whether this login is the
// one that starts the fourteen-day clock.
//
// Every test here leaves the factor tables empty except where it says
// otherwise, because that is production on the day this deploys: the branch
// that matters today is the grace one, and the `parcial` pair below are
// written now precisely because nothing exercises them yet.
describe("estadoInicialDeSesion", () => {
  const ahora = new Date("2026-09-01T10:00:00.000Z");

  it("starts the grace clock on this login and lets the person work", async () => {
    // Day one for this account, whenever their day one happens to be. The
    // deadline is handed back for the caller to store; the state is
    // `completa`, so nothing about the ERP changes for them today.
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("completa");
    expect(r.graceUntil?.getTime()).toBe(ahora.getTime() + MFA_GRACE_DAYS * DIA);
  });

  it("treats a missing mfa_grace_until the same as an unset one", async () => {
    // Not hypothetical, and not caught by the compiler: `IUsuario` declares
    // `mfa_grace_until?: Date | null` and `tsconfig.json` has `strict: false`,
    // so an object built without the key type-checks fine and arrives here as
    // `undefined`. A strict `=== null` test would fall through to the deadline
    // branch, `new Date(undefined)` is an Invalid Date, and every comparison
    // against NaN is false — so the account would be handed `completa` with
    // `graceUntil: null` on every login it ever made. That is a grace period
    // that never starts and therefore never ends: the ERP would never close.
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: undefined }, ahora);
    expect(r.estado).toBe("completa");
    expect(r.graceUntil?.getTime()).toBe(ahora.getTime() + MFA_GRACE_DAYS * DIA);
  });

  it("restarts the clock rather than granting forever when the stored deadline is unusable", async () => {
    // The same failure from a different direction: a column that came back as
    // something `new Date()` cannot parse. Re-stamping a fresh deadline is the
    // safe way to be wrong — it costs the account fourteen more days, where
    // the alternative costs the ERP its closing date altogether.
    const r = await estadoInicialDeSesion(
      { id: YO, mfa_grace_until: new Date("no es una fecha") },
      ahora,
    );
    expect(r.estado).toBe("completa");
    expect(r.graceUntil?.getTime()).toBe(ahora.getTime() + MFA_GRACE_DAYS * DIA);
  });

  it("does not restart a grace period that is already running", async () => {
    // Restarting it on every login is a grace period that never ends, which
    // is the same bug as never starting one — arrived at by being helpful.
    const enCurso = new Date(ahora.getTime() + 3 * DIA);
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: enCurso }, ahora);
    expect(r.estado).toBe("completa");
    expect(r.graceUntil).toBeNull();
  });

  it("drops to onboarding once the grace has run out with nothing configured", async () => {
    const vencida = new Date(ahora.getTime() - 1);
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: vencida }, ahora);
    expect(r.estado).toBe("onboarding");
    expect(r.graceUntil).toBeNull();
  });

  it("closes the ERP at the deadline itself, not a login later", async () => {
    // Pins which side of the boundary the comparison sits on. With `<`
    // instead of `<=` this returns `completa`, and the only way to notice
    // would be somebody logging in at exactly the stored millisecond.
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: new Date(ahora) }, ahora);
    expect(r.estado).toBe("onboarding");
  });

  it("never refuses the login outright, however long the grace has been over", async () => {
    // "El día 15 existe y no echa a nadie." A technician in the field on day
    // 15 gets a screen telling them what to do, never a closed door — so this
    // function has no fourth answer and no throw of its own.
    const vencida = new Date(ahora.getTime() - 30 * DIA);
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: vencida }, ahora);
    expect(["onboarding", "completa", "parcial"]).toContain(r.estado);
  });

  it("asks for the factor when there is one to ask for", async () => {
    // Unreachable in this plan — nothing writes to the three tables yet, so
    // `tieneAlgunFactor` is false for everybody. Written and tested now
    // because the plan that inserts the first row turns this branch on, and a
    // branch first exercised in production is a branch nobody has run.
    passkeyCount.mockResolvedValue(1);
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("parcial");
  });

  it("does not start the grace clock for somebody who already has a factor", async () => {
    // They have nothing to be given fourteen days for. Stamping a deadline on
    // them would put a date in the column that means "this account is still
    // being chased", which is the opposite of the truth.
    passkeyCount.mockResolvedValue(1);
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.graceUntil).toBeNull();
  });

  it("asks for the factor even after the grace has expired", async () => {
    // Order matters: the factor check comes first, so an expired grace does
    // not send somebody who *has* a passkey to the onboarding screen instead
    // of the one asking them to use it.
    passkeyCount.mockResolvedValue(1);
    const r = await estadoInicialDeSesion(
      { id: YO, mfa_grace_until: new Date(ahora.getTime() - DIA) },
      ahora,
    );
    expect(r.estado).toBe("parcial");
  });

  it("counts a confirmed TOTP as a factor to ask for, not only a passkey", async () => {
    totpCount.mockResolvedValue(1);
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("parcial");
  });

  it("does not let a pile of recovery codes stand in for a factor", async () => {
    // The rule `tieneAlgunFactor` enforces, pinned again at the level that
    // actually decides what somebody sees: codes alone must not lift an
    // account out of onboarding, or the sheet of paper becomes the factor.
    codigoCount.mockResolvedValue(10);
    const r = await estadoInicialDeSesion(
      { id: YO, mfa_grace_until: new Date(ahora.getTime() - DIA) },
      ahora,
    );
    expect(r.estado).toBe("onboarding");
  });

  it("asks the two factor tables once each, on the hot path of every login", async () => {
    // This runs on every entry to the system, so the number of round trips it
    // adds is worth pinning rather than re-deriving by reading the call chain
    // each time somebody wonders. Two, and never the recovery-code table.
    await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(passkeyCount).toHaveBeenCalledTimes(1);
    expect(totpCount).toHaveBeenCalledTimes(1);
    expect(codigoCount).not.toHaveBeenCalled();
  });

  it("asks about the account logging in and not about anyone else", async () => {
    await estadoInicialDeSesion({ id: 99, mfa_grace_until: null }, ahora);
    expect(passkeyCount).toHaveBeenCalledWith({ where: { id_usuario: 99 } });
  });
});
