// The migration that gives a schedule its minute. Tested at the level the
// other migrations here are: what it asks of the queryInterface, and that
// every statement rides the same transaction. The real table is exercised by
// `reportSchedule/store.db.test.ts`, which runs every migration of the
// scheduled reports against a throwaway PostgreSQL.

import { describe, it, expect } from "vitest";
import { up, down, RESTRICCION } from "./20261010000004-add-minuto-to-reporte-programaciones.js";

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

describe("add-minuto-to-reporte-programaciones", () => {
  it("adds the minute as a column that every existing schedule reads as 'on the dot'", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(sentencias(qi)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "ALTER TABLE reporte_programaciones ADD COLUMN minuto SMALLINT NOT NULL DEFAULT 0",
      `ALTER TABLE reporte_programaciones ADD CONSTRAINT ${RESTRICCION} CHECK (minuto BETWEEN 0 AND 59)`,
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
    expect(sentencias(qi).at(-1)).toBe("ALTER TABLE reporte_programaciones DROP COLUMN IF EXISTS minuto");
  });
});
