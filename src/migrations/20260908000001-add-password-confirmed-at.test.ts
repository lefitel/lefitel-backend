// The migration that gives sessions a place to record a fresh password
// confirmation, kept separate from proof of an MFA factor.
//
// What has to hold: the column is nullable with no default (an existing
// session must not read as "confirmed"), it carries the same TIMESTAMPTZ
// type as every other timestamp in this schema, and every statement in
// both directions runs inside the one transaction with the lock timeout
// set first.

import { describe, it, expect } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260908000001-add-password-confirmed-at.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    addColumn: record("addColumn"),
    removeColumn: record("removeColumn"),
    sequelize: {
      query: (...args: unknown[]) => {
        calls.push({ fn: "query", args });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

describe("add-password-confirmed-at", () => {
  it("adds password_confirmed_at to sesiones", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toEqual([["sesiones", "password_confirmed_at"]]);
  });

  it("is nullable with no default", async () => {
    // A default, or NOT NULL, would give every session that already exists
    // a value other than "has not confirmed" — the wrong answer for a row
    // that predates this column.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const call = qi.calls.find((c) => c.fn === "addColumn");
    const spec = call?.args[2] as { allowNull?: boolean; defaultValue?: unknown } | undefined;
    expect(spec?.allowNull).toBe(true);
    expect(spec?.defaultValue).toBeUndefined();
  });

  it("carries a timezone, like every other timestamp in this schema", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const call = qi.calls.find((c) => c.fn === "addColumn");
    const spec = call?.args[2] as { type?: unknown } | undefined;
    expect(spec?.type).toBe(DataTypes.DATE);
  });

  it("takes the lock timeout first, before touching the table", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });

  it("carries the transaction on every single call", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(
        transactionOf(call),
        `${call.fn}(${String(call.args[0])}) missing transaction`,
      ).toBeDefined();
    }
  });

  it("removes the column going down", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const removed = qi.calls
      .filter((c) => c.fn === "removeColumn")
      .map((c) => [c.args[0], c.args[1]]);
    expect(removed).toEqual([["sesiones", "password_confirmed_at"]]);
  });

  it("carries the transaction on every single call, going down too", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(
        transactionOf(call),
        `${call.fn}(${String(call.args[0])}) missing transaction in down()`,
      ).toBeDefined();
    }
  });

  it("takes the lock timeout first going down too", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });
});
