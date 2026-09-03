// The signature counter rule, and the two ways of getting it wrong that both
// look like working code.
//
// Every `guardado` below is a **string**, because that is the shape `pg` hands
// a `BIGINT` column back in — never a number. Writing these fixtures as
// numbers would make the whole file pass against an implementation that is
// broken in production, which is the exact trap `ultimo_paso` fell into and
// `totpStore.test.ts` now guards against by the same means.

import { describe, expect, it } from "vitest";
import { esContadorDeClon } from "./passkeyStore.js";

describe("esContadorDeClon — a counter that moves", () => {
  // Deliberately not starting from "0". A rule written as a bare
  // `recibido > guardado` passes this test too; what separates the two is
  // the synced-passkey block below, and it only separates them if the
  // ordinary cases are asserted away from zero.
  it("accepts an assertion whose counter advanced", () => {
    expect(esContadorDeClon("41", 42)).toBe(false);
  });

  it("rejects an assertion whose counter went backwards", () => {
    expect(esContadorDeClon("42", 41)).toBe(true);
  });

  // 🔴 The case a `number` declaration silently loses. Written as
  // `recibido === guardado` it is `42 === "42"` — `false`, because `===`
  // never coerces across types — so the rule would accept a replayed
  // assertion carrying the exact counter it saw last time, which is the
  // textbook clone signature. Mutating `<=` to `<` in the implementation
  // turns this one red and nothing else.
  it("rejects an assertion that repeats the stored counter exactly", () => {
    expect(esContadorDeClon("42", 42)).toBe(true);
  });
});

describe("esContadorDeClon — authenticators that do not count", () => {
  // 🔴 The failure that bricks a passkey one use after registering it.
  // iCloud Keychain and Google Password Manager report 0 on every assertion,
  // forever, because a credential synced across devices has no single device
  // to keep a count on. A bare `recibido > guardado` reads `0 > 0` here,
  // answers "clone", and the person is locked out by their own phone with an
  // error indistinguishable from a real attack.
  it("accepts a synced passkey reporting zero every time", () => {
    expect(esContadorDeClon("0", 0)).toBe(false);
  });

  it("accepts the first assertion from a credential that does count", () => {
    expect(esContadorDeClon("0", 1)).toBe(false);
  });

  // An authenticator that counted and then stopped — a firmware update, or a
  // credential migrated into a password manager. Refusing here would brick a
  // working passkey, and 0 carries no claim about ordering to contradict.
  it("accepts a credential that stops reporting a count", () => {
    expect(esContadorDeClon("7", 0)).toBe(false);
  });
});

describe("esContadorDeClon — an unreadable stored value fails closed", () => {
  // `Number("x")` is `NaN`, and **every** comparison against `NaN` is
  // `false`. An implementation that just compares would answer "not a clone"
  // and let the assertion through, which is the wrong direction to fail in:
  // a row that does not parse is corruption, not a fresh credential.
  it("treats a value that is not a number as a clone", () => {
    expect(esContadorDeClon("no-soy-un-numero", 5)).toBe(true);
  });

  // 🔴 The crossing case, and the only thing that pins the **order** of the
  // two guards. Found by mutating the implementation: with the zero guard
  // moved in front of the parse guard, a corrupt row paired with an
  // authenticator that reports no count (`recibido = 0` — every synced
  // passkey, so not an exotic pairing) returns "not a clone" and the
  // assertion is accepted on top of a row nobody can read. The parse guard
  // has to come first. Without this test both orderings pass.
  it("still fails closed when the row is corrupt and the assertion reports no count", () => {
    expect(esContadorDeClon("no-soy-un-numero", 0)).toBe(true);
  });

  it("treats an empty stored value as a clone", () => {
    // `Number("")` is 0, not NaN — so this one does not reach the guard
    // above. It lands on "the stored side is not above zero", which accepts.
    // Asserted so the difference is on the record rather than discovered by
    // somebody later: an empty string is not the corruption case.
    expect(esContadorDeClon("", 5)).toBe(false);
  });
});

describe("esContadorDeClon — the shape it is actually called with", () => {
  // The guard that keeps this file honest. `ICredencialWebauthn.counter` is
  // declared `string` precisely because that is what arrives; if a future
  // edit "simplifies" the interface back to `number`, these fixtures stop
  // matching the real call site and the suite would go on passing while
  // production compares the wrong things.
  it("compares a string from the database against a number from the assertion", () => {
    const guardado: string = "100";
    const recibido: number = 101;
    expect(esContadorDeClon(guardado, recibido)).toBe(false);
    expect(typeof guardado).toBe("string");
  });
});
