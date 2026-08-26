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

const { factoresDe, tieneAlgunFactor } = await import("./factorInventory.js");

const YO = 1;

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
