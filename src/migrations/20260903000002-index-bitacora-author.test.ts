// The index on the audit log's author column.
//
// Tested at the level every migration here is: what it asks the queryInterface
// for, and that every call carries the transaction. There is no database in
// this suite — the configured one is a copy of production — so what a real
// `CREATE INDEX` does is out of reach, and what can actually be wrong is
// readable from the statement:
//
//   - **the columns, and their order**, because an index on the wrong ones is
//     invisible. Nothing fails, no test goes red, and the three queries this
//     exists for go on scanning the whole log. There is no feedback anywhere
//     until somebody profiles it. `id_usuario` alone is the interesting wrong
//     answer rather than a silly one: it serves the author list perfectly and
//     leaves the two "last fifty entries of this person" queries sorting the
//     whole of somebody's history. That is what the first version of this
//     migration did, and what its post-audit caught.
//   - **the absence of `IF NOT EXISTS`**, asserted because the first version had
//     it and the reason it gave was false. Failure here aborts a deploy and
//     leaves the previous version up (`Dockerfile`); it does not crash-loop
//     anything. And since `IF NOT EXISTS` matches on the name alone, a hand-made
//     index under this name over a different column would be swallowed — the
//     exact blindness the assertion above exists to remove.

import { describe, it, expect } from "vitest";
import { up, down } from "./20260903000002-index-bitacora-author.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    addIndex: record("addIndex"),
    removeIndex: record("removeIndex"),
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

/** The statements, in order, without the `SET LOCAL` preamble. */
const statements = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls
    .filter((c) => c.fn === "query")
    .map((c) => String(c.args[0]))
    .filter((s) => !s.startsWith("SET LOCAL"));

const ran = async (fn: typeof up) => {
  const qi = fakeQueryInterface();
  await fn({ context: qi as never });
  return qi;
};

describe("index-bitacora-author", () => {
  it("indexes bitacoras by the author and then by the entry, in that order", async () => {
    const sql = statements(await ran(up));

    // One statement, and the whole shape read out of it rather than matched
    // loosely. A match on the word `bitacoras` alone would pass for the
    // `entity_id` index that already exists, and a match on `id_usuario` alone
    // would pass for the single-column version this replaced — which serves the
    // author list and leaves the other two queries sorting a person's entire
    // history to find their newest fifty.
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/CREATE INDEX .*ON "bitacoras" \("id_usuario", "id" DESC\)/);
  });

  it("fails loudly on a name somebody already used, instead of quietly doing nothing", async () => {
    // `IF NOT EXISTS` compares names and never definitions, so under it a
    // hand-made `idx_bitacoras_id_usuario` over some other column would report
    // success and leave all three queries scanning the whole log. Failure is
    // already the safe direction here — `Dockerfile` keeps migrations out of
    // `CMD` so that a failed one aborts the deploy and leaves the previous
    // version serving — so the collision should stop somebody, not be swallowed.
    const sql = statements(await ran(up));

    expect(sql[0]).not.toContain("IF NOT EXISTS");
  });

  it("drops exactly the index it created, and tolerates it being gone", async () => {
    // Read off both directions rather than written twice: a rollback that names
    // a different index leaves the real one in place and reports success, and
    // the two names are far enough apart in the file for a rename to update only
    // one of them.
    const nombre = (sql: string) => sql.match(/"(idx_[a-z_]+)"/)?.[1];

    const creado = nombre(statements(await ran(up))[0]);
    const borrado = nombre(statements(await ran(down))[0]);

    expect(creado).toBe("idx_bitacoras_id_usuario");
    expect(borrado).toBe(creado);
    // Tolerated on the way down and not on the way up: a rollback is already
    // the unhappy path, and an index dropped by hand must not be what blocks it.
    expect(statements(await ran(down))[0]).toContain("IF EXISTS");
  });

  it("runs everything it does inside the transaction", async () => {
    // Including the `SET LOCAL`, which is the point of it: set outside the
    // transaction it applies to the session and either leaks or does nothing,
    // and the lock bound this migration claims to have would not exist.
    for (const fn of [up, down]) {
      const qi = await ran(fn);
      const sinTransaccion = qi.calls.filter(
        (c) => (c.args.at(-1) as { transaction?: unknown } | undefined)?.transaction === undefined,
      );
      expect(sinTransaccion, `llamadas fuera de la transacción en ${fn.name}`).toEqual([]);
    }
  });

  it("bounds how long it waits for the lock", async () => {
    const qi = await ran(up);
    const preamble = qi.calls
      .filter((c) => c.fn === "query")
      .map((c) => String(c.args[0]))
      .filter((s) => s.startsWith("SET LOCAL"));

    expect(preamble).toEqual(["SET LOCAL lock_timeout = '5s'"]);
  });
});
