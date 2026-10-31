// The migration that gives a tramo its encargado. Tested at the level the other
// migrations here are: what it asks of the queryInterface, and that every
// statement rides the same transaction. Against PostgreSQL it was run by hand
// on the local copy (2026-10-31): up, down twice, up, and the foreign key read
// back as ON DELETE SET NULL. What reads the column is exercised by the
// generator's `sqlExecution.test.ts`.

import { describe, it, expect } from "vitest";
import { up, down, RESTRICCION, INDICE } from "./20261031000001-add-tramo-encargado.js";

function fakeQueryInterface() {
  const calls: { sql: string; options: { transaction?: unknown } }[] = [];
  return {
    calls,
    sequelize: {
      query: (sql: string, options: { transaction?: unknown }) => {
        calls.push({ sql: String(sql), options });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const sentencias = (qi: ReturnType<typeof fakeQueryInterface>) => qi.calls.map((c) => c.sql.replace(/\s+/g, " ").trim());

describe("add-tramo-encargado", () => {
  it("adds a nullable column pointing at a user, and its index", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(sentencias(qi)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      `ALTER TABLE tramos ADD COLUMN "id_encargado" INTEGER NULL CONSTRAINT ${RESTRICCION}` +
        " REFERENCES usuarios (id) ON UPDATE CASCADE ON DELETE SET NULL",
      `CREATE INDEX ${INDICE} ON tramos ("id_encargado")`,
    ]);
  });

  it("runs every statement inside the one transaction, in both directions", async () => {
    for (const paso of [up, down]) {
      const qi = fakeQueryInterface();
      await paso({ context: qi as never });
      expect(qi.calls.length).toBeGreaterThan(1);
      expect(qi.calls.every((c) => c.options?.transaction !== undefined)).toBe(true);
    }
  });

  it("goes back by dropping the column, and can be run twice", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    expect(sentencias(qi).at(-1)).toBe(`ALTER TABLE tramos DROP COLUMN IF EXISTS "id_encargado"`);
  });
});
