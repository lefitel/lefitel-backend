// The migration that gives sessions a state and users a grace deadline.
//
// Three things are asserted and each one is a night's work if it goes wrong:
// that every call carries the transaction, that the existing rows are
// back-filled rather than left to the column default, and that the CHECK
// constraints spell the state names the code will compare against.

import { describe, it, expect } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260826000002-add-mfa-columns.js";

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
      query: record("query"),
      literal: (s: string) => ({ val: s }),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const queriesOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

describe("add-mfa-columns", () => {
  it("adds the five columns, to the two tables that need them", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toEqual([
      ["usuarios", "mfa_grace_until"],
      ["usuarios", "pass_changed_at"],
      ["sesiones", "estado"],
      ["sesiones", "mfa_satisfied_at"],
      ["sesiones", "mfa_source"],
    ]);
  });

  it("carries the transaction on every single call", async () => {
    // A migration that runs half way is the failure that costs a night: five
    // columns added and the back-fill not, or the constraints not, leaves the
    // table in a shape no version of the code expects.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn}(${String(call.args[0])}) sin transacción`).toBeDefined();
    }
  });

  it("takes the lock timeout first, before touching anything", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });

  it("back-fills pass_changed_at from the account's own creation date", async () => {
    // Not from now(). The condition `sesion.created_at >= usuario.pass_changed_at`
    // that Task 8 puts inside `authenticate` would then be false for every
    // session alive at deploy time, and everybody would be thrown out at once
    // — for a column that was only ever meant to invalidate sessions older
    // than a password *change*.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    expect(sql).toMatch(/UPDATE\s+usuarios\s+SET\s+pass_changed_at\s*=\s*"createdAt"/i);
  });

  it("spells the three session states exactly as the code will compare them", async () => {
    // A CHECK is worth having only if it names the same strings the
    // application does. `parcial`/`onboarding`/`completa` are compared as
    // literals in `sessionState.ts`; a typo here makes a legitimate login fail
    // at INSERT time with a constraint error nobody will read as "typo".
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    expect(sql).toContain("'parcial'");
    expect(sql).toContain("'onboarding'");
    expect(sql).toContain("'completa'");
  });

  it("constrains mfa_source to the four sources that exist", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    for (const source of ["passkey", "totp", "codigo", "dispositivo"]) {
      expect(sql).toContain(`'${source}'`);
    }
  });

  it("gives every existing session the state that keeps it working", async () => {
    // `completa` as the column default is what stops this migration logging
    // out the whole company: the rows that exist were opened before states
    // existed, and they were, in the old sense, complete.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const estado = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "estado");
    expect((estado?.args[2] as { defaultValue?: string })?.defaultValue).toBe("completa");
  });

  it("gives pass_changed_at a now() default, without which the deploy aborts", async () => {
    // `estado`'s default is pinned above; this one was not, and losing it does
    // not merely weaken the migration — it stops it.
    //
    // `ALTER TABLE usuarios ADD COLUMN pass_changed_at TIMESTAMPTZ NOT NULL`
    // with no default is rejected outright by Postgres against a non-empty
    // table: there is no value to put in the existing rows. The migration
    // aborts on the deploy, before the back-fill on the next line ever runs,
    // and the whole MFA arc stops at the door. A mutation test deleted this
    // default and 1207 tests stayed green.
    //
    // `allowNull` is pinned in the same breath because the two only mean
    // anything together: NOT NULL is what makes the default load-bearing, and a
    // silent drop to nullable would let the column exist holding NULLs, which
    // `authenticate` refuses since it stopped trusting an unreadable stamp.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const columna = qi.calls.find(
      (c) => c.fn === "addColumn" && c.args[0] === "usuarios" && c.args[1] === "pass_changed_at",
    );
    const spec = columna?.args[2] as { allowNull?: boolean; defaultValue?: unknown } | undefined;
    expect(spec?.allowNull).toBe(false);
    expect(spec?.defaultValue).toBeDefined();
    // The literal itself, not merely "something truthy": a default of the
    // string "now()" would be written into every row verbatim.
    expect(JSON.stringify(spec?.defaultValue)).toMatch(/now\(\)/i);
  });

  it("gives the three timestamp columns a timezone, like every other timestamp in this schema", async () => {
    // TIMESTAMPTZ is a hard constraint on this project; DataTypes.DATE is what
    // Sequelize maps to it. A naive TIMESTAMP here would drift by however many
    // hours separate the server's timezone from UTC — the same class of bug
    // the account-lockout migration's note on locked_until exists to avoid.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const typeOf = (table: string, column: string) => {
      const call = qi.calls.find(
        (c) => c.fn === "addColumn" && c.args[0] === table && c.args[1] === column,
      );
      return (call?.args[2] as { type?: unknown } | undefined)?.type;
    };

    expect(typeOf("usuarios", "mfa_grace_until")).toBe(DataTypes.DATE);
    expect(typeOf("usuarios", "pass_changed_at")).toBe(DataTypes.DATE);
    expect(typeOf("sesiones", "mfa_satisfied_at")).toBe(DataTypes.DATE);
  });

  it("reverses cleanly", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const removed = qi.calls.filter((c) => c.fn === "removeColumn").map((c) => [c.args[0], c.args[1]]);
    expect(removed).toEqual([
      ["sesiones", "mfa_source"],
      ["sesiones", "mfa_satisfied_at"],
      ["sesiones", "estado"],
      ["usuarios", "pass_changed_at"],
      ["usuarios", "mfa_grace_until"],
    ]);
    // The constraints go before the columns they constrain, or the DROP fails.
    const sql = queriesOf(qi);
    expect(sql).toContain("DROP CONSTRAINT");
  });

  it("carries the transaction on every single call, going down too", async () => {
    // The same "runs half way" failure the up-path test above guards against,
    // but on the rollback: "reverses cleanly" exercises down() without ever
    // checking the transaction, so a regression that dropped { transaction }
    // from a removeColumn or a DROP CONSTRAINT query here would go undetected.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn}(${String(call.args[0])}) sin transacción en down()`).toBeDefined();
    }
  });

  it("drops the constraints before it removes the columns they constrain", async () => {
    // "reverses cleanly" only checks that a DROP CONSTRAINT appears somewhere
    // in the query log, never that it runs before removeColumn(sesiones, ...).
    // If that order flipped, this would still pass while the down migration
    // failed against a real database: Postgres refuses to drop a column a
    // CHECK still references, so removeColumn("sesiones", "estado", ...) would
    // throw instead of running.
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const lastDropConstraintIndex = qi.calls.reduce(
      (last, call, i) =>
        call.fn === "query" && String(call.args[0]).includes("DROP CONSTRAINT") ? i : last,
      -1,
    );
    const firstSesionesRemoveColumnIndex = qi.calls.findIndex(
      (call) => call.fn === "removeColumn" && call.args[0] === "sesiones",
    );

    expect(lastDropConstraintIndex).toBeGreaterThanOrEqual(0);
    expect(firstSesionesRemoveColumnIndex).toBeGreaterThanOrEqual(0);
    expect(
      lastDropConstraintIndex,
      "a DROP CONSTRAINT ran after removeColumn(sesiones, ...): against a real database that removeColumn would fail outright, since Postgres refuses to drop a column a CHECK still references",
    ).toBeLessThan(firstSesionesRemoveColumnIndex);
  });
});
