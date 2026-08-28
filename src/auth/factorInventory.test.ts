// `factoresDe` and `tieneAlgunFactor` — written whole in Task 6 rather than
// stubbed, because `requireStepUp` needs a real answer from the first
// request it ever gates and a branch first exercised in production is a
// branch nobody has run. Two rules are load-bearing enough to need their own
// test each: an unconfirmed TOTP secret is not a factor, and a pile of
// recovery codes alone is not one either. See factorInventory.ts's own
// comment for why.
//
// ---
//
// **The three model mocks are fake tables, not canned numbers, and that is
// what Task 15 corrected here.** They used to be `vi.fn()`s handed an answer
// with `mockResolvedValue`, so they returned the same count whatever `where`
// they were passed. Measured by a mutation run over this arc: deleting
// `confirmed_at IS NOT NULL` from either query left every behaviour test in
// this file green — the one whose *name is the rule* included — and reddened
// exactly one, the assertion comparing the shape of the `where`. And that
// assertion compared operator identity, so rewriting `{[Op.ne]: null}` as
// `{[Op.not]: null}`, which Sequelize compiles to the same SQL, reddened it
// too. The rule's only guard failed on correct code and passed on every
// incorrect behaviour, which is the worst of both directions.
//
// So the mocks now hold rows and read the `where` to decide which of them
// match. An unconfirmed secret is a row *in the table*, and a query that
// forgets to exclude it counts it — which reds the test named for the rule,
// where the rule is named.
//
// What is on the other side of that rule: a secret generated and never
// scanned counts as a factor, so that account opens its next session in
// `parcial` and is asked for a code nobody can produce — shut out by a factor
// it never finished registering, with no endpoint in the API to undo it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

type Fila = Record<string, unknown>;

/**
 * Decides whether one row satisfies a Sequelize `where`.
 *
 * Operators are read by **meaning**, not by identity — the same approach
 * `rememberedDeviceStore.test.ts` takes, for the same reason. `Op.ne` and
 * `Op.not` against `null` both compile to `IS NOT NULL`, so a rewrite between
 * them is a correct refactor and has to stay green, while a `where` that lost
 * the clause altogether has to go red. An assertion that compares the clause
 * to a literal gets both of those backwards.
 *
 * Anything it does not understand throws instead of quietly matching. A fake
 * that shrugs at an operator it has never seen is a fake that stops testing
 * anything the day the query grows a condition.
 */
function coincide(fila: Fila, where: Fila): boolean {
  for (const combinador of Object.getOwnPropertySymbols(where)) {
    throw new Error(`the fake table does not understand the combinator ${String(combinador)}`);
  }

  return Object.entries(where).every(([columna, clausula]) => {
    const valor = fila[columna];
    if (clausula === null || clausula instanceof Date || typeof clausula !== "object") {
      return valor === clausula;
    }
    return Object.getOwnPropertySymbols(clausula).every((op) => {
      const limite = (clausula as Record<symbol, unknown>)[op];
      if (op === Op.eq || op === Op.is) return valor === limite;
      if (op === Op.ne || op === Op.not) return valor !== limite;
      throw new Error(`the fake table does not understand the operator ${String(op)}`);
    });
  });
}

/** The rows each fake table holds. Empty unless a test says otherwise. */
let passkeys: Fila[] = [];
let secretosTotp: Fila[] = [];
let codigos: Fila[] = [];

/**
 * `Model.count` for a fake table: it answers from the rows and from the
 * `where` it was handed, and never from a number the test decided in advance.
 *
 * `(...args: unknown[])` rather than a typed parameter list because the mocked
 * models forward their arguments with a spread.
 */
const contar = (tabla: () => Fila[]) =>
  vi.fn(async (...args: unknown[]) => {
    const where = (args[0] as { where?: Fila } | undefined)?.where ?? {};
    return tabla().filter((f) => coincide(f, where)).length;
  });

const passkeyCount = contar(() => passkeys);
const totpCount = contar(() => secretosTotp);
const codigoCount = contar(() => codigos);

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
const OTRA_CUENTA = 99;
const DIA = 24 * 60 * 60 * 1000;

/** A passkey of the account under test. Every row here is already a factor. */
const PASSKEY: Fila = { id_usuario: YO };
/** Somebody else's passkey, to prove the queries are scoped to one account. */
const PASSKEY_AJENA: Fila = { id_usuario: OTRA_CUENTA };

/** A TOTP secret that was scanned and typed back. A real factor. */
const TOTP_CONFIRMADO: Fila = {
  id_usuario: YO,
  confirmed_at: new Date("2026-08-20T09:00:00.000Z"),
};
/**
 * A TOTP secret generated and never confirmed — a QR that may never have been
 * scanned, or scanned wrong, or abandoned halfway. **Not a factor**, and the
 * row every "does not count" test below puts in the table.
 */
const TOTP_SIN_CONFIRMAR: Fila = { id_usuario: YO, confirmed_at: null };

const CODIGO_SIN_USAR: Fila = { id_usuario: YO, used_at: null };
const CODIGO_USADO: Fila = {
  id_usuario: YO,
  used_at: new Date("2026-08-21T09:00:00.000Z"),
};

/** The `where` of the last call this fake received. */
const whereDe = (mock: { mock: { calls: unknown[][] } }): Fila =>
  (mock.mock.calls.at(-1)?.[0] as { where?: Fila } | undefined)?.where ?? {};

/**
 * Does this `where` ask the database for confirmed secrets only?
 *
 * Answered by running the clause over the two rows above through the same
 * interpreter the fake tables use, rather than by comparing it to a literal —
 * so every spelling Sequelize compiles to `IS NOT NULL` passes, and a `where`
 * that dropped the clause fails.
 */
const pideSoloConfirmados = (where: Fila): boolean =>
  coincide(TOTP_CONFIRMADO, where) && !coincide(TOTP_SIN_CONFIRMAR, where);

/** The same question for the recovery-code table's `used_at IS NULL`. */
const pideSoloSinUsar = (where: Fila): boolean =>
  coincide(CODIGO_SIN_USAR, where) && !coincide(CODIGO_USADO, where);

beforeEach(() => {
  passkeyCount.mockClear();
  totpCount.mockClear();
  codigoCount.mockClear();
  passkeys = [];
  secretosTotp = [];
  codigos = [];
});

describe("factoresDe", () => {
  it("returns zero for every kind on an account with nothing registered", async () => {
    // The tables are empty today — this is the true answer, not a stub.
    expect(await factoresDe(YO)).toEqual({ passkeys: 0, totp: 0, codigos: 0 });
  });

  it("counts every passkey the account has registered, scoped to that account", async () => {
    passkeys = [PASSKEY, PASSKEY, PASSKEY_AJENA];
    expect((await factoresDe(YO)).passkeys).toBe(2);
  });

  it("does NOT count a TOTP secret that was never confirmed", async () => {
    // The rule, at the level of the inventory. The row is in the table; the
    // query is what has to leave it out.
    secretosTotp = [TOTP_SIN_CONFIRMAR];
    expect((await factoresDe(YO)).totp).toBe(0);
  });

  it("counts a TOTP secret that was confirmed", async () => {
    // The other direction, so that the test above cannot be satisfied by a
    // query that counts nothing at all.
    secretosTotp = [TOTP_CONFIRMADO];
    expect((await factoresDe(YO)).totp).toBe(1);
  });

  it("asks the database for confirmed TOTP secrets only, not merely existing ones", async () => {
    // The rule lives in the WHERE clause itself, not in a filter applied
    // afterwards that somebody could accidentally skip when adding a new
    // caller. Read by meaning: any clause Sequelize compiles to
    // `confirmed_at IS NOT NULL` passes here.
    secretosTotp = [TOTP_SIN_CONFIRMAR];
    await factoresDe(YO);

    const where = whereDe(totpCount);
    expect(where.id_usuario).toBe(YO);
    expect(pideSoloConfirmados(where), "el WHERE no excluye los TOTP sin confirmar").toBe(true);
  });

  it("does NOT count a recovery code that has already been redeemed", async () => {
    codigos = [CODIGO_SIN_USAR, CODIGO_USADO];
    expect((await factoresDe(YO)).codigos).toBe(1);
  });

  it("asks the database for unredeemed recovery codes only", async () => {
    codigos = [CODIGO_USADO];
    await factoresDe(YO);

    const where = whereDe(codigoCount);
    expect(where.id_usuario).toBe(YO);
    expect(pideSoloSinUsar(where), "el WHERE no excluye los códigos ya gastados").toBe(true);
  });
});

describe("tieneAlgunFactor", () => {
  it("is false for an account with nothing registered", async () => {
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("is true with a passkey and nothing else", async () => {
    passkeys = [PASSKEY];
    expect(await tieneAlgunFactor(YO)).toBe(true);
  });

  it("is true with a confirmed TOTP factor", async () => {
    secretosTotp = [TOTP_CONFIRMADO];
    expect(await tieneAlgunFactor(YO)).toBe(true);
  });

  it("does NOT count an unconfirmed TOTP secret as a factor", async () => {
    // **The test whose name is the rule, and it now exercises it.** The
    // unconfirmed secret is a row in the fake table, so the only thing that
    // keeps this answer `false` is the `confirmed_at IS NOT NULL` in this
    // function's own query. Drop it and this goes red, which is what it says
    // on the tin and what it did not do until Task 15.
    //
    // A secret generated and never typed back is a QR somebody may have
    // failed to scan; counting it would demand a code they cannot produce.
    secretosTotp = [TOTP_SIN_CONFIRMAR];
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("asks the database for confirmed TOTP secrets only, in its own query", async () => {
    // `tieneAlgunFactor` runs its own `FactorTotpModel.count`, separate from
    // `factoresDe`'s — see that function's own comment for why. That split
    // means `factoresDe`'s own test of this WHERE proves nothing about *this*
    // function's query, and the two have to be pinned one each.
    secretosTotp = [TOTP_SIN_CONFIRMAR];
    await tieneAlgunFactor(YO);

    const where = whereDe(totpCount);
    expect(where.id_usuario).toBe(YO);
    expect(pideSoloConfirmados(where), "el WHERE no excluye los TOTP sin confirmar").toBe(true);
  });

  it("does not count another account's factors as this account's", async () => {
    // A query that lost its `id_usuario` answers `true` for everybody, which
    // is a second factor nobody has to prove.
    passkeys = [PASSKEY_AJENA];
    secretosTotp = [{ id_usuario: OTRA_CUENTA, confirmed_at: new Date() }];
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("does NOT count recovery codes alone as a factor, however many there are", async () => {
    // Load-bearing: without this exclusion, onboarding could be finished
    // with a sheet of paper and nothing registered.
    codigos = Array.from({ length: 8 }, () => CODIGO_SIN_USAR);
    expect(await tieneAlgunFactor(YO)).toBe(false);
  });

  it("is true even when recovery codes are also present, for the right reason", async () => {
    // Proves the OR is `passkeys > 0 || totp > 0` and not something that
    // happens to look right only when codigos is zero.
    secretosTotp = [TOTP_CONFIRMADO];
    codigos = Array.from({ length: 8 }, () => CODIGO_SIN_USAR);
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
    // Not hypothetical and not caught by the compiler: `IUsuario` declares
    // `mfa_grace_until?: Date | null` and `tsconfig.json` has `strict: false`,
    // so an object built without the key type-checks fine and arrives here as
    // `undefined`.
    //
    // **What this test guards is the `Number.isNaN` branch, not the loose
    // `== null` beside it.** Tightening that to `=== null` leaves this green,
    // because `undefined` then reaches `new Date(undefined)` and comes back
    // NaN into the same branch. Delete the NaN check and this goes red. An
    // earlier version of this comment credited the wrong line; a review caught
    // it, and the distinction is written down now so the next reader does not
    // trust the shortcut instead of the guard.
    //
    // What it costs to get wrong: every comparison against NaN is false, so
    // the account would be handed `completa` with `graceUntil: null` on every
    // login it ever made — a grace period that never starts and so never ends,
    // and an ERP that never closes.
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

  it("answers instead of throwing, for every shape of deadline it can be handed", async () => {
    // "El día 15 existe y no echa a nadie." A technician in the field on day
    // 15 gets a screen telling them what to do, never a closed door.
    //
    // **What this can actually catch is a throw, and nothing else** — worth
    // saying rather than leaving to be discovered. `EstadoSesion` has exactly
    // three members, so asserting the answer is one of them is satisfied by
    // the return type alone; as the plan first wrote this test, against a
    // single input, it could not fail. It earns its place by being run over
    // the inputs most likely to blow up instead: a deadline long past, the
    // epoch, an absent column and an unparseable one. A `throw` here is a
    // login that 500s, which is the closed door the rule forbids.
    const hostiles = [
      new Date(ahora.getTime() - 30 * DIA),
      new Date(0),
      null,
      undefined,
      new Date("no es una fecha"),
    ];
    for (const mfa_grace_until of hostiles) {
      const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until }, ahora);
      expect(["onboarding", "completa", "parcial"], String(mfa_grace_until)).toContain(r.estado);
      // And an answer that is actually usable: `graceUntil` is either a real
      // date to store or an explicit null, never an Invalid Date the caller
      // would happily write into the column.
      expect(
        r.graceUntil === null || !Number.isNaN(r.graceUntil.getTime()),
        String(mfa_grace_until),
      ).toBe(true);
    }
  });

  it("asks for the factor when there is one to ask for", async () => {
    // Unreachable in this plan — nothing writes to the three tables yet, so
    // `tieneAlgunFactor` is false for everybody. Written and tested now
    // because the plan that inserts the first row turns this branch on, and a
    // branch first exercised in production is a branch nobody has run.
    passkeys = [PASSKEY];
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("parcial");
  });

  it("does not start the grace clock for somebody who already has a factor", async () => {
    // They have nothing to be given fourteen days for. Stamping a deadline on
    // them would put a date in the column that means "this account is still
    // being chased", which is the opposite of the truth.
    passkeys = [PASSKEY];
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.graceUntil).toBeNull();
  });

  it("asks for the factor even after the grace has expired", async () => {
    // Order matters: the factor check comes first, so an expired grace does
    // not send somebody who *has* a passkey to the onboarding screen instead
    // of the one asking them to use it.
    passkeys = [PASSKEY];
    const r = await estadoInicialDeSesion(
      { id: YO, mfa_grace_until: new Date(ahora.getTime() - DIA) },
      ahora,
    );
    expect(r.estado).toBe("parcial");
  });

  it("counts a confirmed TOTP as a factor to ask for, not only a passkey", async () => {
    secretosTotp = [TOTP_CONFIRMADO];
    const r = await estadoInicialDeSesion({ id: YO, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("parcial");
  });

  it("does not ask for a TOTP secret that was never confirmed", async () => {
    // **The lockout this rule exists to prevent, at the level that decides
    // what somebody actually sees.** With the unconfirmed row counted, this
    // account opens its session in `parcial` and is asked for a code it cannot
    // produce — and `parcial` reaches five routes, none of which can register
    // or confirm a factor. `onboarding` is the correct answer and the only one
    // with a way out: it opens six more doors, the setup screens among them.
    secretosTotp = [TOTP_SIN_CONFIRMAR];
    const r = await estadoInicialDeSesion(
      { id: YO, mfa_grace_until: new Date(ahora.getTime() - DIA) },
      ahora,
    );
    expect(r.estado).toBe("onboarding");
  });

  it("does not let a pile of recovery codes stand in for a factor", async () => {
    // The rule `tieneAlgunFactor` enforces, pinned again at the level that
    // actually decides what somebody sees: codes alone must not lift an
    // account out of onboarding, or the sheet of paper becomes the factor.
    codigos = Array.from({ length: 10 }, () => CODIGO_SIN_USAR);
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
    // Behaviour and not just the shape of the query: the other account's
    // passkey is in the table, and it must not put this login into `parcial`.
    passkeys = [PASSKEY];
    const r = await estadoInicialDeSesion(
      { id: OTRA_CUENTA, mfa_grace_until: new Date(ahora.getTime() - DIA) },
      ahora,
    );
    expect(r.estado).toBe("onboarding");
    expect(passkeyCount).toHaveBeenCalledWith({ where: { id_usuario: OTRA_CUENTA } });
  });
});
