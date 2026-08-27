// Which doors each session state opens.
//
// Every assertion here calls `puedeAlcanzar` directly rather than reading
// `sessionState.ts`'s source text: three tasks in this arc's history shipped
// tests that matched a file's contents against a substring, and every one of
// them turned out satisfiable by a doc comment or a slice that covered the
// wrong region. A pure function is tested by calling it.

import { describe, it, expect } from "vitest";
import { puedeAlcanzar, estadoEfectivo } from "./sessionState.js";

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

describe("the state actually in force, once a session has been open a while", () => {
  // `estado` is decided once, at login, and written into the session row.
  // Nothing rewrote it and nothing revoked a session when its account's
  // `mfa_grace_until` went by, so somebody who logged in on day 13 was still
  // `completa` on day 15 — and stayed that way for as long as the session
  // lived, which `authenticate`'s sliding expiry stretches to the thirty-day
  // ceiling. `estadoEfectivo` is what makes the date apply to a session that
  // was already open when it arrived.

  const AHORA = new Date("2026-01-15T12:00:00.000Z");
  const AYER = new Date("2026-01-14T12:00:00.000Z");
  const MANANA = new Date("2026-01-16T12:00:00.000Z");

  it("turns a complete session into onboarding once the deadline has passed", () => {
    expect(estadoEfectivo("completa", AYER, AHORA)).toBe("onboarding");
  });

  it("leaves a complete session alone while the deadline is still ahead", () => {
    // The other side of the same rule, and the one that keeps this from being
    // an outage: refusing a grace period that is still running would lock out
    // the whole company on the day it deployed.
    expect(estadoEfectivo("completa", MANANA, AHORA)).toBe("completa");
  });

  it("counts the deadline's own millisecond as already past", () => {
    // `<=`, matching `estadoInicialDeSesion` exactly. The stored instant is
    // when the grace is *over*, and a login and a request that land on the same
    // millisecond have to reach the same answer — otherwise the login says
    // `completa` and the very next request says `onboarding`.
    expect(estadoEfectivo("completa", AHORA, AHORA)).toBe("onboarding");
    expect(estadoEfectivo("completa", new Date(AHORA.getTime() + 1), AHORA)).toBe("completa");
  });

  it("treats a deadline it cannot read as a clock that never started", () => {
    // NULL is the column's ordinary value, not a fault: every account has it
    // until its first login after the deploy, and again after the reprieve
    // `estadoInicialDeSesion` documents (`UPDATE usuarios SET mfa_grace_until =
    // NULL`). Reading it as "the deadline passed" would 403 the entire payroll
    // and would turn that reprieve into its opposite. `undefined` and an
    // unparseable date get the same answer for the same reason.
    expect(estadoEfectivo("completa", null, AHORA)).toBe("completa");
    expect(estadoEfectivo("completa", undefined, AHORA)).toBe("completa");
    expect(estadoEfectivo("completa", new Date("no es una fecha"), AHORA)).toBe("completa");
  });

  it("never moves a partial session, whose state no clock changes", () => {
    // Not a detail: `PERMITIDAS` gives `onboarding` everything `parcial` opens
    // **plus six more doors**, so moving `parcial` to `onboarding` because a
    // date went by would *widen* what that session reaches. And it would be
    // wrong on its own terms — `parcial` means the account has a factor and has
    // not proved it yet, which no deadline alters.
    expect(estadoEfectivo("parcial", AYER, AHORA)).toBe("parcial");
    expect(estadoEfectivo("parcial", MANANA, AHORA)).toBe("parcial");
    expect(estadoEfectivo("parcial", null, AHORA)).toBe("parcial");
  });

  it("never moves an onboarding session back to complete, whatever the deadline says", () => {
    // A deadline that moved into the future does not undo onboarding here. The
    // two ways out of it are registering a factor — a write at the moment it
    // happens, which is plan 4B's — and logging in again, which is exactly what
    // the reprieve in `estadoInicialDeSesion` says it needs. Answering it here
    // would mean asking `tieneAlgunFactor`, i.e. two COUNTs against two more
    // tables on every request in the ERP, to catch a transition that happens at
    // most once per account.
    expect(estadoEfectivo("onboarding", MANANA, AHORA)).toBe("onboarding");
    expect(estadoEfectivo("onboarding", null, AHORA)).toBe("onboarding");
    expect(estadoEfectivo("onboarding", AYER, AHORA)).toBe("onboarding");
  });

  it("can only ever narrow what a session reaches, never widen it", () => {
    // The property that makes it safe to run this in front of the whole API:
    // the only move it makes is `completa` → `onboarding`, and everything
    // `onboarding` opens, `completa` opened too. So the worst a bug in here can
    // do is refuse somebody who should have got through — loud, and undone by
    // logging out and back in — never let somebody through who should have been
    // refused.
    //
    // Asserted by calling `puedeAlcanzar` rather than by reading the table,
    // and over routes from both allowlists plus the ERP, so it keeps holding
    // the day `completa` stops being the literal `"todo"` that makes it true
    // today.
    const rutas = [
      "/api/usuario",
      "/api/poste/1",
      "/api/auth/me",
      "/api/auth/logout",
      "/api/auth/mfa/verify",
      "/api/auth/email/send",
      "/api/auth/totp/setup",
      "/api/auth/sessions",
      "/api/auth/recovery-codes",
    ];
    for (const ruta of rutas) {
      if (puedeAlcanzar("onboarding", ruta)) {
        expect(puedeAlcanzar("completa", ruta), ruta).toBe(true);
      }
    }
    // And the move is a real one, not a no-op dressed up as safe: at least one
    // of those routes is open to `completa` and shut to `onboarding`.
    expect(puedeAlcanzar("completa", "/api/usuario")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/usuario")).toBe(false);
  });
});
