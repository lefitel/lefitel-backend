// Which doors each session state opens.
//
// Every assertion here calls `puedeAlcanzar` directly rather than reading
// `sessionState.ts`'s source text: three tasks in this arc's history shipped
// tests that matched a file's contents against a substring, and every one of
// them turned out satisfiable by a doc comment or a slice that covered the
// wrong region. A pure function is tested by calling it.

import { describe, it, expect } from "vitest";
import {
  puedeAlcanzar,
  puedeVerArchivosEstaticos,
  estadoEfectivo,
  esPruebaDeFactor,
  ESTADOS_SESION,
} from "./sessionState.js";
import type { EstadoSesion } from "./sessionState.js";

describe("what each session state opens", () => {
  it("lets a partial session reach only the doors that can finish the login", () => {
    expect(puedeAlcanzar("parcial", "/api/auth/mfa/verify")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/logout")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/me")).toBe(true);
  });

  it("closes the ERP to a partial session, which is the whole point", () => {
    // The single most important assertion in this plan. Without it the second
    // factor is decorative: the password alone reaches the data.
    expect(puedeAlcanzar("parcial", "/api/usuario")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/poste/1")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/permiso/1")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/auth/totp/setup")).toBe(false);
  });

  it("does not let a partial session log somebody out of everywhere", () => {
    // `logoutAll` revokes the caller's sessions *and* their remembered
    // devices. A `parcial` session is somebody who typed the right password
    // and has not proved their second factor — so this is the one door in
    // that list that acts on the account rather than on the session in hand.
    //
    // Left open, a leaked password buys an unlimited loop: log in (which
    // costs nothing in any bucket, since both login limiters skip successful
    // requests), call this, repeat. The victim is thrown off every device and
    // stripped of every remembered device, so each way back demands the full
    // ceremony — the classic setup for a fatigue campaign or a real-time
    // phishing page.
    expect(puedeAlcanzar("parcial", "/api/auth/logout-all")).toBe(false);
  });

  it("still lets a partial session abandon its own session", () => {
    // The distinction this whole change rests on: leaving is yours, and
    // closing everybody else's is the account's. `coincide` is exact-or-
    // slash-suffix rather than a bare `startsWith`, which is why removing
    // `logout-all` actually removes it — `/api/auth/logout` does not swallow
    // it. Written down because if that ever loosens to `startsWith`, this
    // fix silently becomes a no-op and only this pair of tests would say so.
    expect(puedeAlcanzar("parcial", "/api/auth/logout")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/logout-all")).toBe(false);
  });

  it("still lets an onboarding session log itself out of everywhere", () => {
    // `onboarding` is somebody setting their factor up: they proved what
    // there was to prove and the deadline is what holds them. Closing their
    // other sessions is theirs to do, and taking it away with the same edit
    // would be collateral damage — `onboarding` is spread from `PARCIAL`.
    expect(puedeAlcanzar("onboarding", "/api/auth/logout-all")).toBe(true);
  });

  it("still lets a complete session log itself out of everywhere", () => {
    expect(puedeAlcanzar("completa", "/api/auth/logout-all")).toBe(true);
  });

  it("lets an onboarding session set itself up, and nothing else", () => {
    expect(puedeAlcanzar("onboarding", "/api/auth/email/send")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/totp/setup")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/webauthn/register/options")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/recovery-codes/regenerate")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/usuario")).toBe(false);
  });

  it("opens everything to a complete session", () => {
    expect(puedeAlcanzar("completa", "/api/usuario")).toBe(true);
    expect(puedeAlcanzar("completa", "/api/auth/me")).toBe(true);
  });

  it("matches on whole path segments, not on string prefixes", () => {
    // `/api/auth/mefoo` starts with `/api/auth/me`. A naive startsWith would
    // open any route somebody later mounts under a name that happens to share
    // an allowed prefix.
    expect(puedeAlcanzar("parcial", "/api/auth/mefoo")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/auth/sessions-all")).toBe(false);
  });

  it("ignores the query string", () => {
    expect(puedeAlcanzar("parcial", "/api/auth/me?x=1")).toBe(true);
  });
});

describe("which states may reach a stored photograph", () => {
  // `puedeVerArchivosEstaticos` is a second, independent allowlist —
  // deliberately not read out of `PERMITIDAS`, whose every entry is
  // `/api/auth/...` and has no opinion about `/1712428860328_210.jpg`. This
  // is the finding itself, pinned directly: before this function existed,
  // `authenticate` had nothing else to ask about a path outside `/api/...`,
  // consulted `puedeAlcanzar` anyway, and got a silent `false` for
  // `onboarding` — 403 on every photograph in the ERP, the day an account's
  // grace period ran out. See `app.images.test.ts` for the same three cases
  // through the real mount.
  it("shuts a partial session out, same as the ERP", () => {
    expect(puedeVerArchivosEstaticos("parcial")).toBe(false);
  });

  it("opens it to an onboarding session — the regression this task closes", () => {
    expect(puedeVerArchivosEstaticos("onboarding")).toBe(true);
  });

  it("leaves it open to a complete session, unchanged", () => {
    expect(puedeVerArchivosEstaticos("completa")).toBe(true);
  });

  it("says nothing about the API allowlist, and the API allowlist says nothing about this", () => {
    // The two tables answer independently. `parcial` cannot reach
    // `/api/usuario` and cannot reach a photograph either, but for different,
    // unrelated reasons — proving one is silent about the other is the whole
    // point of keeping them apart, so a future edit to one cannot quietly
    // narrow or widen the other by accident.
    expect(puedeAlcanzar("onboarding", "/1712428860328_210.jpg")).toBe(false);
    expect(puedeVerArchivosEstaticos("onboarding")).toBe(true);
  });
});

describe("the state actually in force, once a session has been open a while", () => {
  // `estado` is decided once, at login, and written into the session row.
  // Nothing rewrote it and nothing revoked a session when its account's
  // `mfa_grace_until` went by, so somebody who logged in on day 13 was still
  // `completa` on day 15 — and stayed that way for as long as the session
  // lived, which `authenticate`'s sliding expiry stretches to the thirty-day
  // ceiling. `estadoEfectivo` is what makes the date apply to a session that
  // was already open when it arrived.
  //
  // The other half of this block is the reason it takes the whole session row
  // rather than just the deadline: `mfa_grace_until` is **never cleared once
  // stamped**, so "the deadline passed" is not the same question as "this
  // account still has nothing registered", and answering the first when you
  // mean the second locks out for ever everybody who complies late.

  const AHORA = new Date("2026-01-15T12:00:00.000Z");
  /** The deadline went by yesterday. */
  const VENCIDO = new Date("2026-01-14T12:00:00.000Z");
  /** Still a day of grace left. */
  const POR_VENCER = new Date("2026-01-16T12:00:00.000Z");
  /** Opened before the deadline: a session the deadline is genuinely about. */
  const ABIERTA_ANTES = new Date("2026-01-10T12:00:00.000Z");

  /**
   * A session row as `findLiveSession` returns it. The defaults are the shape
   * of the defect: `completa`, opened while there was still grace left, with no
   * sign anywhere that a factor was ever involved.
   */
  const sesion = (extra: Partial<Parameters<typeof estadoEfectivo>[0]> = {}) => ({
    estado: "completa" as EstadoSesion,
    created_at: ABIERTA_ANTES,
    mfa_satisfied_at: null,
    mfa_source: null,
    ...extra,
  });

  it("turns a complete session into onboarding once the deadline has passed", () => {
    expect(estadoEfectivo(sesion(), VENCIDO, AHORA)).toBe("onboarding");
  });

  it("leaves a complete session alone while the deadline is still ahead", () => {
    // The other side of the same rule, and the one that keeps this from being
    // an outage: refusing a grace period that is still running would lock out
    // the whole company on the day it deployed.
    expect(estadoEfectivo(sesion(), POR_VENCER, AHORA)).toBe("completa");
  });

  it("counts the deadline's own millisecond as already past", () => {
    // `<=`, matching `estadoInicialDeSesion` exactly. The stored instant is
    // when the grace is *over*, and a login and a request that land on the same
    // millisecond have to reach the same answer — otherwise the login says
    // `completa` and the very next request says `onboarding`.
    expect(estadoEfectivo(sesion(), AHORA, AHORA)).toBe("onboarding");
    expect(estadoEfectivo(sesion(), new Date(AHORA.getTime() + 1), AHORA)).toBe("completa");
  });

  it("treats a deadline it cannot read as a clock that never started", () => {
    // NULL is the column's ordinary value, not a fault: every account has it
    // until its first login after the deploy, and again after the reprieve
    // `estadoInicialDeSesion` documents (`UPDATE usuarios SET mfa_grace_until =
    // NULL`). Reading it as "the deadline passed" would 403 the entire payroll
    // and would make that reprieve do the opposite of what it is written down
    // as doing. `undefined` and an unparseable date get the same answer for the
    // same reason.
    expect(estadoEfectivo(sesion(), null, AHORA)).toBe("completa");
    expect(estadoEfectivo(sesion(), undefined, AHORA)).toBe("completa");
    expect(estadoEfectivo(sesion(), new Date("no es una fecha"), AHORA)).toBe("completa");
  });

  it("never moves a partial session, whose state no clock changes", () => {
    // Not a detail: `PERMITIDAS` gives `onboarding` everything `parcial` opens
    // **plus six more doors**, so moving `parcial` to `onboarding` because a
    // date went by would *widen* what that session reaches. And it would be
    // wrong on its own terms — `parcial` means the account has a factor and has
    // not proved it yet, which no deadline alters.
    expect(estadoEfectivo(sesion({ estado: "parcial" }), VENCIDO, AHORA)).toBe("parcial");
    expect(estadoEfectivo(sesion({ estado: "parcial" }), POR_VENCER, AHORA)).toBe("parcial");
    expect(estadoEfectivo(sesion({ estado: "parcial" }), null, AHORA)).toBe("parcial");
  });

  it("never moves an onboarding session back to complete, whatever the deadline says", () => {
    // A deadline that moved into the future does not undo onboarding here. The
    // way out is registering a factor and having the endpoint that did it
    // promote the row — after which the clauses below keep it promoted.
    expect(estadoEfectivo(sesion({ estado: "onboarding" }), POR_VENCER, AHORA)).toBe("onboarding");
    expect(estadoEfectivo(sesion({ estado: "onboarding" }), null, AHORA)).toBe("onboarding");
    expect(estadoEfectivo(sesion({ estado: "onboarding" }), VENCIDO, AHORA)).toBe("onboarding");
  });

  describe("the sessions the deadline is not about", () => {
    // **The lockout this scoping exists to prevent.** `mfa_grace_until` is
    // stamped once and never cleared — its only writer fires solely when
    // `estadoInicialDeSesion` hands back a date, and the branch for "this
    // account has a factor" hands back `null`, which means "leave the column
    // alone". So the stamp stays in the past for ever, including on accounts
    // that went and registered a factor afterwards.
    //
    // Narrowing on the stamp alone therefore answered 403 to the whole ERP on a
    // fully compliant account, on every request, with logging out and back in
    // returning to the same place. Every test here is a session that has
    // complied and must keep the ERP.

    it("does not narrow a session opened after the deadline had already gone by", () => {
      // The clause that needs nothing at all from plan 4B. With the deadline
      // already past, `estadoInicialDeSesion` answers `onboarding` for an
      // account with nothing registered and `parcial` for one with a factor —
      // never `completa`. So a `completa` row created after its own deadline
      // can only have been promoted there by something that verified a factor,
      // whatever else that something did or did not write.
      const despues = sesion({ created_at: new Date("2026-01-14T12:00:00.001Z") });
      expect(estadoEfectivo(despues, VENCIDO, AHORA)).toBe("completa");
    });

    it("does not narrow a session that proved a factor, however long ago", () => {
      // No time window, deliberately. `requireStepUp` measures this same column
      // against `STEP_UP_WINDOW_MINUTES`, and copying that here would drop a
      // legitimately authenticated person into `onboarding` ten minutes after
      // they proved their factor. The two questions differ: step-up asks
      // whether a factor was proved *recently enough* to authorise a write,
      // this asks whether the account has one at all, and that does not expire.
      const recien = sesion({ mfa_satisfied_at: new Date(AHORA.getTime() - 1_000) });
      const haceUnMes = sesion({ mfa_satisfied_at: new Date("2025-12-15T12:00:00.000Z") });
      expect(estadoEfectivo(recien, VENCIDO, AHORA)).toBe("completa");
      expect(estadoEfectivo(haceUnMes, VENCIDO, AHORA)).toBe("completa");
    });

    it("does not treat a remembered device as proof that a factor was shown", () => {
      // This used to assert the opposite, on the premise that "a device can
      // only have been remembered for an account that proved a factor once".
      // True when written, and it stops being true the moment that account
      // deletes its last factor — after which the exemption is **permanent and
      // has no window**, so the session keeps the whole ERP for its full thirty
      // days on the strength of a cookie nobody proved anything with.
      //
      // `dispositivo` is the worst of the four sources for exactly that reason:
      // it is the only one written **without anybody proving anything at that
      // moment**. The other three name a factor that was shown.
      const dispositivo = sesion({ mfa_source: "dispositivo" });
      expect(estadoEfectivo(dispositivo, VENCIDO, AHORA)).toBe("onboarding");

      for (const fuente of ["passkey", "totp", "codigo", "correo"]) {
        expect(estadoEfectivo(sesion({ mfa_source: fuente }), VENCIDO, AHORA), fuente).toBe(
          "completa",
        );
      }
    });

    it("still narrows the session the deadline really is about", () => {
      // The guard against the exemptions swallowing the rule. A session opened
      // inside the grace period, with no sign of a factor anywhere on the row,
      // is exactly the case this whole task exists for and none of the three
      // clauses may rescue it.
      expect(estadoEfectivo(sesion(), VENCIDO, AHORA)).toBe("onboarding");
    });

    it("counts an absent evidence column as no evidence, rather than as evidence", () => {
      // **The direction these two comparisons fail in.** Written strictly
      // (`!== null`), a column that is *missing* rather than null reads as
      // "there is evidence here" and switches the whole rule off — the one
      // failure mode this function must not have, and the opposite of what its
      // two siblings do: `mfa_grace_until` and `created_at` are both compared
      // with `== null`, so an absent value narrows. `requireStepUp` leans the
      // same way, where an undefined stamp gives `NaN <= x`, i.e. false, i.e.
      // refuse.
      //
      // `strictNullChecks` is off in this project, so `undefined` is assignable
      // to `Date | null` and the compiler will not stop anybody producing this
      // row. The reachable way in is a projection that stops naming a column,
      // which `sessionStore.test.ts` pins today — and the shared fixture in
      // `app.auth.test.ts` was itself a field short of `mfa_source` until Task
      // 15, saved only by omitting `mfa_grace_until` too. A rule that switches
      // itself off when a fixture is a field short is not a rule, which is why
      // the short row is exercised here rather than left to a fixture that
      // happens to be one.
      const sinSource = { ...sesion(), mfa_source: undefined };
      const sinSello = { ...sesion(), mfa_satisfied_at: undefined };
      const sinNinguna = {
        estado: "completa" as EstadoSesion,
        created_at: ABIERTA_ANTES,
      } as Parameters<typeof estadoEfectivo>[0];

      expect(estadoEfectivo(sinSource, VENCIDO, AHORA)).toBe("onboarding");
      expect(estadoEfectivo(sinSello, VENCIDO, AHORA)).toBe("onboarding");
      expect(estadoEfectivo(sinNinguna, VENCIDO, AHORA)).toBe("onboarding");
    });

    it("gives an unreadable created_at no exemption", () => {
      // The safe direction, and the same both-sided reasoning as the
      // `pass_changed_at` guard in `authenticate`: `NaN >= limite` is `false`,
      // so a row whose opening date cannot be read narrows rather than walking
      // past the rule. `authenticate` refuses such a row well before this runs,
      // but this function is exported and does not get to assume that.
      const ilegible = sesion({ created_at: new Date("no es una fecha") });
      expect(estadoEfectivo(ilegible, VENCIDO, AHORA)).toBe("onboarding");
    });
  });

  it("can only ever narrow what a session reaches, never widen it", () => {
    // The property that makes it safe to run this in front of the whole API:
    // whatever `estadoEfectivo` answers, it opens no door the stored state did
    // not already open. So the worst a bug in here can do is refuse somebody
    // who should have got through, never let somebody through who should have
    // been refused.
    //
    // Asserted on the **real outputs of `estadoEfectivo`**, across the whole
    // matrix of stored state × deadline × factor evidence, and not by iterating
    // `puedeAlcanzar` over a hand-written list of routes: the first version of
    // this test did the latter, which meant the test carrying the invariant's
    // name never called the function the invariant is about. A second movement
    // inside `estadoEfectivo` would have left it green with the property already
    // false.
    //
    // **And the state axis is complete by construction, not by care.**
    // `ESTADOS_SESION` is derived from `PERMITIDAS`, which is a
    // `Record<EstadoSesion, …>`, so a fourth state cannot be added to the union
    // without a compile error — measured: adding one puts TS2741 on
    // `sessionState.ts`. While that list was a hand-written literal, a fourth
    // state compiled fine, this loop skipped it, and the test went on passing
    // about a property it was no longer checking.
    const rutas = [
      "/api/usuario",
      "/api/poste/1",
      "/api/auth/me",
      "/api/auth/logout",
      "/api/auth/mfa/verify",
      "/api/auth/mfa/email-code",
      "/api/auth/email/send",
      "/api/auth/totp/setup",
      "/api/auth/sessions",
      "/api/auth/recovery-codes",
    ];
    const limites = [VENCIDO, POR_VENCER, AHORA, null, undefined, new Date("nada")];
    const pruebas = [
      {},
      { created_at: new Date("2026-01-14T12:00:00.001Z") },
      { mfa_satisfied_at: AHORA },
      { mfa_source: "dispositivo" },
    ];

    let estrechoAlgunaVez = false;
    for (const estado of ESTADOS_SESION) {
      for (const limite of limites) {
        for (const extra of pruebas) {
          const entrada = sesion({ estado, ...extra });
          const salida = estadoEfectivo(entrada, limite, AHORA);
          if (salida !== estado) estrechoAlgunaVez = true;
          for (const ruta of rutas) {
            if (puedeAlcanzar(salida, ruta)) {
              // Everything the answer opens, the stored state opened too.
              expect(puedeAlcanzar(estado, ruta), `${estado} → ${salida} · ${ruta}`).toBe(true);
            }
          }
        }
      }
    }
    // And the move is a real one, not a no-op dressed up as safe: somewhere in
    // that matrix the function actually changed the state, and the change is a
    // narrowing rather than nothing at all.
    expect(estrechoAlgunaVez).toBe(true);
    expect(puedeAlcanzar("completa", "/api/usuario")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/usuario")).toBe(false);
  });
});

/**
 * One rule, two readers: `estadoEfectivo`'s clause 3 and `createSession`'s
 * `mfa_satisfied_at` both ask this. The mutation that matters is
 * `fuente !== "dispositivo"` → `fuente != null`, which would seal a session
 * born from a remembered device — the hole migration `20260826000002` names.
 */
describe("esPruebaDeFactor — which sources are evidence a factor was shown", () => {
  it("counts every source that names something somebody showed", () => {
    for (const fuente of ["passkey", "totp", "codigo", "correo"]) {
      expect(esPruebaDeFactor(fuente), fuente).toBe(true);
    }
  });

  it("does not count a remembered device: nobody proved anything at that moment", () => {
    expect(esPruebaDeFactor("dispositivo")).toBe(false);
  });

  it("does not count no source at all", () => {
    expect(esPruebaDeFactor(null)).toBe(false);
    expect(esPruebaDeFactor(undefined)).toBe(false);
  });
});
