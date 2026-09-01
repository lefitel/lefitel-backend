// The migration that finally removes `sesiones.estado`'s `DEFAULT 'completa'`
// — split out of `20260827000001` because it is only safe once the previous
// image (the one whose `createSession` does not name `estado`) is fully
// retired. See the header for the measured NOT NULL violation that is the
// whole reason this file exists.

import { describe, it, expect } from "vitest";
import { up, down } from "./20260827000002-drop-sesiones-estado-default.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.map((c) => String(c.args[0])).join("\n");

async function ran(direccion: typeof up | typeof down) {
  const qi = fakeQueryInterface();
  await direccion({ context: qi as never });
  return qi;
}

describe("drop-sesiones-estado-default", () => {
  it("takes the lock timeout first, before altering anything", async () => {
    expect(String((await ran(up)).calls[0].args[0])).toContain("lock_timeout");
  });

  it("carries the transaction on every call, up and down", async () => {
    for (const direccion of [up, down]) {
      const qi = await ran(direccion);
      expect(qi.calls.length).toBeGreaterThan(0);
      for (const call of qi.calls) {
        expect(transactionOf(call), `${String(call.args[0])} sin transacción`).toBeDefined();
      }
    }
  });

  it("drops the default that let a session be minted 'completa' without asking", async () => {
    // The one change here, and it is the one `20260827000001` backed out of
    // making, because doing it there raced the deploy order and the
    // documented rollback. See this file's header for the precondition that
    // makes it safe here instead.
    expect(sqlOf(await ran(up))).toMatch(
      /ALTER TABLE sesiones ALTER COLUMN estado DROP DEFAULT/i,
    );
  });

  it("puts the default back, faithfully, on the way down", async () => {
    // Faithful rather than opinionated: this default is a known hole
    // (§ header), and restoring it on `down` is still correct, because a
    // `down` that improves on the state it reverts to is a `down` whose dump
    // no longer matches what `up` actually undoes.
    expect(sqlOf(await ran(down))).toMatch(
      /ALTER TABLE sesiones ALTER COLUMN estado SET DEFAULT 'completa'/i,
    );
  });
});
